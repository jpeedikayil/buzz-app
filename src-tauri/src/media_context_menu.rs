//! The native WebKit menu on the main window's relay media, on macOS.
//!
//! - WebKit reports a download started from this menu (Download Video, Audio
//!   or Image) only to the private `_webView:contextMenuDidCreateDownload:`
//!   (`WKNavigationDelegatePrivate.h`, macOS 12). Wry implements only the
//!   public download hooks, so the download has no delegate and WebKit
//!   cancels it. For relay media, Buzz attaches a `WKDownloadDelegate` that
//!   saves to Downloads under the media's `<hash>.<ext>` name, not the
//!   attachment name the player's Download uses; WebKit streams the file
//!   and quarantines it. A failed download's partial file is removed. Each
//!   result is sent to the main window as `media-menu-download`: the saved
//!   file's name, or null if it failed.
//! - `<video>` and `<audio>` play from the tokened loopback listener
//!   (`relay::media_stream`). Copy … Address, Open … in New Window and
//!   Share… would hand that URL, token included, to the clipboard, a window
//!   or another app, so they are removed before the menu opens. So is
//!   Download … when Buzz cannot save it, which WebKit would cancel.
//!
//! Both methods are added to Wry's classes, which every Wry webview shares,
//! Buzz Browser guests included. They act only for the main webview, so the
//! others behave as before. A class that already has either method, as a Wry
//! upgrade might, keeps its own: media menus then keep their URL items, or
//! lose Download … because Buzz cannot save it.

use std::{
    cell::{OnceCell, RefCell},
    collections::HashSet,
    path::{Path, PathBuf},
    sync::OnceLock,
};

use block2::Block;
use objc2::{
    define_class, msg_send,
    rc::{Retained, Weak},
    runtime::{AnyClass, AnyObject, Imp, NSObject, ProtocolObject, Sel},
    sel, DefinedClass, MainThreadOnly, Message,
};
use objc2_app_kit::{NSEvent, NSMenu, NSUserInterfaceItemIdentification};
use objc2_foundation::{
    MainThreadMarker, NSData, NSError, NSHTTPURLResponse, NSObjectProtocol, NSProgressReporting,
    NSString, NSURLResponse, NSURL,
};
use objc2_web_kit::{WKDownload, WKDownloadDelegate, WKWebView};
use tauri::Emitter as _;

/// Items on a `<video>` or `<audio>` menu that hand out its URL. Elsewhere
/// Share… shares an image or the selection, so it stays there.
const MEDIA_LINKS: [&str; 3] = [
    "WKMenuItemIdentifierCopyMediaLink",
    "WKMenuItemIdentifierOpenMediaInNewWindow",
    "WKMenuItemIdentifierShareMenu",
];
const DOWNLOAD_MEDIA: &str = "WKMenuItemIdentifierDownloadMedia";
/// Items only a `<video>` or `<audio>` menu has.
const MEDIA_ITEMS: [&str; 4] = [
    "WKMenuItemIdentifierCopyMediaLink",
    "WKMenuItemIdentifierOpenMediaInNewWindow",
    DOWNLOAD_MEDIA,
    "WKMenuItemIdentifierShowHideMediaControls",
];

type DidCreateDownload =
    unsafe extern "C-unwind" fn(&AnyObject, Sel, Option<&WKWebView>, Option<&WKDownload>);
type WillOpenMenu = unsafe extern "C-unwind" fn(&WKWebView, Sel, Option<&NSMenu>, Option<&NSEvent>);

thread_local! {
    static MAIN: OnceCell<Main> = const { OnceCell::new() };
}
/// The `willOpenMenu:withEvent:` Wry's webview class inherits, which Buzz's
/// calls first.
static INHERITED_WILL_OPEN_MENU: OnceLock<Imp> = OnceLock::new();

struct Main {
    webview: Weak<WKWebView>,
    /// Held here because a download holds its delegate weakly. None if menu
    /// downloads cannot be saved.
    downloads: Option<Retained<DownloadDelegate>>,
}

struct Downloads {
    app: tauri::AppHandle,
    directory: PathBuf,
    /// The loopback listener's base URL, from which `<video>` and `<audio>`
    /// load.
    stream: Option<String>,
    /// Destinations WebKit has accepted for downloads still running. The
    /// network process creates each file later, so until then only this
    /// shows the name is taken.
    pending: RefCell<HashSet<PathBuf>>,
}

define_class!(
    #[unsafe(super(NSObject))]
    #[name = "BuzzMediaDownloadDelegate"]
    #[thread_kind = MainThreadOnly]
    #[ivars = Downloads]
    struct DownloadDelegate;

    unsafe impl NSObjectProtocol for DownloadDelegate {}

    unsafe impl WKDownloadDelegate for DownloadDelegate {
        #[unsafe(method(download:decideDestinationUsingResponse:suggestedFilename:completionHandler:))]
        fn decide_destination(
            &self,
            download: &WKDownload,
            response: &NSURLResponse,
            _suggested_filename: &NSString,
            completion_handler: &Block<dyn Fn(*mut NSURL)>,
        ) {
            let downloads = self.ivars();
            // An error's body is not the media. No destination cancels it.
            let path = response
                .downcast_ref::<NSHTTPURLResponse>()
                .filter(|response| response.statusCode() == 200)
                .and_then(|_| self.name(download))
                .and_then(|name| {
                    free_path(&downloads.directory, &name, &downloads.pending.borrow())
                });
            let destination = path.as_deref().and_then(NSURL::from_file_path);
            completion_handler.call((destination
                .as_deref()
                .map_or(std::ptr::null_mut(), |url| (url as *const NSURL).cast_mut()),));
            // WebKit refuses a destination that already exists, and sets the
            // file URL only on one it accepts, before the handler returns.
            if let Some(path) = path.filter(|path| destination_of(download).as_ref() == Some(path))
            {
                downloads.pending.borrow_mut().insert(path);
            }
        }

        #[unsafe(method(downloadDidFinish:))]
        fn did_finish(&self, download: &WKDownload) {
            let name = self
                .release(download)
                .and_then(|path| Some(path.file_name()?.to_string_lossy().into_owned()));
            self.notify(Some(name.unwrap_or_default()));
        }

        #[unsafe(method(download:didFailWithError:resumeData:))]
        fn did_fail(&self, download: &WKDownload, error: &NSError, _resume_data: Option<&NSData>) {
            // The error's description may hold the tokened URL.
            eprintln!(
                "Could not download media: {} {}",
                error.domain(),
                error.code()
            );
            // WebKit keeps what arrived for resuming, which Buzz never offers.
            // Only a destination this delegate handed out is removed.
            if let Some(partial) = self.release(download) {
                if let Err(error) = std::fs::remove_file(partial) {
                    if error.kind() != std::io::ErrorKind::NotFound {
                        eprintln!("Could not remove a partial media download: {error}");
                    }
                }
            }
            self.notify(None);
        }
    }
);

impl DownloadDelegate {
    /// The Downloads name for `download`, if it is of relay media.
    fn name(&self, download: &WKDownload) -> Option<String> {
        let source = unsafe { download.originalRequest() }?
            .URL()?
            .absoluteString()?;
        media_name(&source.to_string(), self.ivars().stream.as_deref())
    }

    /// Frees `download`'s destination for later downloads, returning it if
    /// this delegate handed it out.
    fn release(&self, download: &WKDownload) -> Option<PathBuf> {
        let path = destination_of(download)?;
        self.ivars()
            .pending
            .borrow_mut()
            .remove(&path)
            .then_some(path)
    }

    /// Tells the main window a download saved as `name`, or failed. Never
    /// its URL, which holds the listener's token.
    fn notify(&self, name: Option<String>) {
        let _ = self
            .ivars()
            .app
            .emit_to("main", "media-menu-download", name);
    }
}

/// The destination WebKit accepted for `download`, if any.
fn destination_of(download: &WKDownload) -> Option<PathBuf> {
    download.progress().fileURL()?.to_file_path()
}

/// Installs both hooks for the main window's webview. Downloads go to
/// `directory`, if there is one, and their results to `app`'s main window;
/// `stream` is the loopback listener's base URL. Call once, on the main
/// thread.
pub(crate) fn install(
    webview: &tauri::webview::PlatformWebview,
    app: tauri::AppHandle,
    directory: Option<PathBuf>,
    stream: Option<String>,
) {
    let Some(marker) = MainThreadMarker::new() else {
        return;
    };
    if MAIN.with(|cell| cell.get().is_some()) {
        return;
    }
    // SAFETY: Wry's macOS webview is a WKWebView.
    let webview = unsafe { &*webview.inner().cast::<WKWebView>() };
    let downloads = match directory {
        Some(directory) if install_download_hook(webview) => {
            let allocated = DownloadDelegate::alloc(marker).set_ivars(Downloads {
                app,
                directory,
                stream,
                pending: RefCell::default(),
            });
            let delegate: Retained<DownloadDelegate> = unsafe { msg_send![super(allocated), init] };
            Some(delegate)
        }
        _ => {
            eprintln!("Downloads from the media menu are unavailable");
            None
        }
    };
    let main = Main {
        webview: Weak::from(webview),
        downloads,
    };
    MAIN.with(|cell| cell.set(main)).ok();
    if !install_menu_hook(webview) {
        eprintln!("The media menu could not hide local media links");
    }
}

/// Whether the main webview's menu downloads now reach Buzz.
fn install_download_hook(webview: &WKWebView) -> bool {
    let Some(delegate) = (unsafe { webview.navigationDelegate() }) else {
        return false;
    };
    let hook: DidCreateDownload = context_menu_did_create_download;
    // SAFETY: the hook takes the selector's arguments.
    let added = unsafe {
        add_method(
            class_of(&*delegate),
            sel!(_webView:contextMenuDidCreateDownload:),
            std::mem::transmute::<DidCreateDownload, Imp>(hook),
        )
    };
    if added {
        // WebKit checks which optional methods a delegate has when it is set.
        unsafe { webview.setNavigationDelegate(Some(&delegate)) };
    }
    added
}

/// Whether the main webview's media menus now lose their URL items.
fn install_menu_hook(webview: &WKWebView) -> bool {
    let class = class_of(webview);
    let selector = sel!(willOpenMenu:withEvent:);
    let Some(inherited) = class.instance_method(selector) else {
        return false;
    };
    if INHERITED_WILL_OPEN_MENU
        .set(inherited.implementation())
        .is_err()
    {
        return false;
    }
    let hook: WillOpenMenu = will_open_menu;
    // SAFETY: the hook takes the selector's arguments.
    unsafe {
        add_method(
            class,
            selector,
            std::mem::transmute::<WillOpenMenu, Imp>(hook),
        )
    }
}

/// The class `object` reports, which Key-Value Observing does not replace.
fn class_of<T: Message>(object: &T) -> &'static AnyClass {
    unsafe { msg_send![object, class] }
}

/// Adds `imp` for `selector`, a method taking two objects and returning
/// nothing, unless `class` has its own already.
///
/// # Safety
///
/// `imp` must take the method's arguments.
unsafe fn add_method(class: &AnyClass, selector: Sel, imp: Imp) -> bool {
    let class = (class as *const AnyClass).cast_mut();
    unsafe { objc2::ffi::class_addMethod(class, selector, imp, c"v@:@@".as_ptr()) }.as_bool()
}

/// Runs `f` if `webview` is the main window's.
fn if_main(webview: &WKWebView, f: impl FnOnce(&Main)) {
    MAIN.with(|main| {
        let main = main.get().filter(|main| {
            main.webview
                .load()
                .is_some_and(|main| std::ptr::eq(&*main, webview))
        });
        if let Some(main) = main {
            f(main);
        }
    });
}

unsafe extern "C-unwind" fn context_menu_did_create_download(
    _delegate: &AnyObject,
    _selector: Sel,
    webview: Option<&WKWebView>,
    download: Option<&WKDownload>,
) {
    let (Some(webview), Some(download)) = (webview, download) else {
        return;
    };
    if_main(webview, |main| {
        // Any other download keeps no delegate, and WebKit cancels it as before.
        let delegate = main
            .downloads
            .as_ref()
            .filter(|delegate| delegate.name(download).is_some());
        if let Some(delegate) = delegate {
            unsafe { download.setDelegate(Some(ProtocolObject::from_ref(&**delegate))) };
        }
    });
}

unsafe extern "C-unwind" fn will_open_menu(
    webview: &WKWebView,
    selector: Sel,
    menu: Option<&NSMenu>,
    event: Option<&NSEvent>,
) {
    if let Some(inherited) = INHERITED_WILL_OPEN_MENU.get() {
        // SAFETY: the method this one overrides, which takes the same arguments.
        let inherited = unsafe { std::mem::transmute::<Imp, WillOpenMenu>(*inherited) };
        unsafe { inherited(webview, selector, menu, event) };
    }
    if let Some(menu) = menu {
        if_main(webview, |main| {
            hide_media_links(menu, main.downloads.is_some());
        });
    }
}

fn hide_media_links(menu: &NSMenu, saves: bool) {
    let items: Vec<Item> = menu
        .itemArray()
        .iter()
        .map(|item| {
            if item.isSeparatorItem() {
                Item::Separator
            } else {
                Item::Action(item.identifier().map(|identifier| identifier.to_string()))
            }
        })
        .collect();
    for index in hidden_items(&items, saves).into_iter().rev() {
        menu.removeItemAtIndex(index as isize);
    }
}

#[derive(Debug)]
enum Item {
    Separator,
    /// An item and its `WKMenuItemIdentifier…`, if it has one.
    Action(Option<String>),
}

/// The indexes, ascending, to remove from a native context menu: on media,
/// the items that hand out its URL, and Download … unless Buzz `saves` it,
/// then the separators that leaves first, last or doubled.
fn hidden_items(items: &[Item], saves: bool) -> Vec<usize> {
    let is = |names: &[&str], item: &Item| match item {
        Item::Action(Some(identifier)) => names.contains(&identifier.as_str()),
        _ => false,
    };
    if !items.iter().any(|item| is(&MEDIA_ITEMS, item)) {
        return Vec::new();
    }
    let mut hidden = Vec::new();
    let mut after_separator = true;
    let mut trailing = None;
    for (index, item) in items.iter().enumerate() {
        match item {
            _ if is(&MEDIA_LINKS, item) || (!saves && is(&[DOWNLOAD_MEDIA], item)) => {
                hidden.push(index)
            }
            Item::Separator if after_separator => hidden.push(index),
            Item::Separator => {
                after_separator = true;
                trailing = Some(index);
            }
            Item::Action(_) => {
                after_separator = false;
                trailing = None;
            }
        }
    }
    hidden.extend(trailing);
    hidden.sort_unstable();
    hidden
}

/// The Downloads name for a menu download of relay media: the loopback URL
/// a `<video>` or `<audio>` plays, which ends in its `buzz-media` path, or
/// the `buzz-media` URL an image shows. Any other source has none.
fn media_name(source: &str, stream: Option<&str>) -> Option<String> {
    let source = match stream.and_then(|base| source.strip_prefix(base)) {
        Some(path) => format!("buzz-media://localhost/{path}"),
        None => source.to_owned(),
    };
    let url = crate::relay::download_target(&source)?;
    Some(crate::relay::download_name("", &url).to_owned())
}

/// The first of `name`'s numbered names that nothing in `directory` has
/// and no `pending` download will create. WebKit fails a download whose
/// destination exists.
fn free_path(directory: &Path, name: &str, pending: &HashSet<PathBuf>) -> Option<PathBuf> {
    crate::relay::download_names(name)
        .map(|candidate| directory.join(candidate))
        .find(|path| {
            !pending.contains(path)
                && std::fs::symlink_metadata(path)
                    .is_err_and(|error| error.kind() == std::io::ErrorKind::NotFound)
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `-` is a separator and `` an item without an identifier; other names
    /// drop their `WKMenuItemIdentifier` prefix.
    fn menu(names: &[&str]) -> Vec<Item> {
        names
            .iter()
            .map(|name| match *name {
                "-" => Item::Separator,
                "" => Item::Action(None),
                name => Item::Action(Some(format!("WKMenuItemIdentifier{name}"))),
            })
            .collect()
    }

    #[test]
    fn media_menus_lose_only_the_items_that_hand_out_the_loopback_url() {
        // WebKit's `<video>` menu on macOS 27: Play, Mute, Show Controls, Loop,
        // Full Screen, Picture in Picture, Viewer, then the URL items.
        let video = menu(&[
            "",
            "",
            "ShowHideMediaControls",
            "",
            "ToggleFullScreen",
            "TogglePictureInPicture",
            "ToggleVideoViewer",
            "-",
            "CopyMediaLink",
            "OpenMediaInNewWindow",
            "DownloadMedia",
            "-",
            "ShareMenu",
        ]);
        assert_eq!(hidden_items(&video, true), [8, 9, 11, 12]);
        // Download Video goes when Buzz cannot save it, which WebKit would
        // cancel, and with it the separator it leaves last.
        assert_eq!(hidden_items(&video, false), [7, 8, 9, 10, 11, 12]);
        // Separators left first or doubled go too.
        let media = menu(&[
            "CopyMediaLink",
            "-",
            "DownloadMedia",
            "-",
            "ShareMenu",
            "-",
            "",
        ]);
        assert_eq!(hidden_items(&media, true), [0, 1, 4, 5]);
        assert_eq!(hidden_items(&media, false), [0, 1, 2, 3, 4, 5]);
    }

    #[test]
    fn other_menus_keep_share_and_every_item() {
        let image = menu(&[
            "OpenImageInNewWindow",
            "DownloadImage",
            "CopyImage",
            "-",
            "ShareMenu",
        ]);
        let selection = menu(&["LookUp", "-", "Copy", "-", "ShareMenu"]);
        for saves in [true, false] {
            assert!(hidden_items(&image, saves).is_empty());
            assert!(hidden_items(&selection, saves).is_empty());
        }
    }

    #[test]
    fn menu_downloads_are_named_only_for_relay_media() {
        let base = "http://127.0.0.1:4321/token/";
        let encode = |url: &str| {
            percent_encoding::utf8_percent_encode(url, percent_encoding::NON_ALPHANUMERIC)
                .to_string()
        };
        let hash = "a".repeat(64);
        let video = encode(&format!("https://relay.test/media/{hash}.mp4"));
        let image = encode(&format!("https://relay.test/media/{hash}.png"));
        assert_eq!(
            media_name(&format!("{base}{video}"), Some(base)),
            Some(format!("{hash}.mp4"))
        );
        assert_eq!(
            media_name(&format!("buzz-media://localhost/{image}"), Some(base)),
            Some(format!("{hash}.png"))
        );
        for source in [
            format!("{base}{video}?download"),
            format!("{base}{}", encode("https://relay.test/other.mp4")),
            format!("http://127.0.0.1:4321/other/{video}"),
            format!("https://relay.test/media/{hash}.mp4"),
            "https://example.test/file.zip".to_owned(),
        ] {
            assert_eq!(media_name(&source, Some(base)), None, "{source}");
        }
        assert_eq!(media_name(&format!("{base}{video}"), None), None);
    }

    #[test]
    fn menu_downloads_take_the_first_free_numbered_name() {
        let dir = tempfile::tempdir().unwrap();
        let none = HashSet::new();
        assert_eq!(
            free_path(dir.path(), "clip.mp4", &none).unwrap(),
            dir.path().join("clip.mp4")
        );
        std::fs::write(dir.path().join("clip.mp4"), b"").unwrap();
        // A dangling link still occupies its name.
        std::os::unix::fs::symlink(dir.path().join("gone"), dir.path().join("clip (1).mp4"))
            .unwrap();
        assert_eq!(
            free_path(dir.path(), "clip.mp4", &none).unwrap(),
            dir.path().join("clip (2).mp4")
        );
    }

    #[test]
    fn menu_downloads_skip_names_a_running_download_will_create() {
        let dir = tempfile::tempdir().unwrap();
        // Two downloads of one video before the first has created its file.
        let mut pending = HashSet::from([dir.path().join("clip.mp4")]);
        assert_eq!(
            free_path(dir.path(), "clip.mp4", &pending).unwrap(),
            dir.path().join("clip (1).mp4")
        );
        pending.insert(dir.path().join("clip (1).mp4"));
        assert_eq!(
            free_path(dir.path(), "clip.mp4", &pending).unwrap(),
            dir.path().join("clip (2).mp4")
        );
        // A failed download's name is free again once released.
        pending.remove(&dir.path().join("clip.mp4"));
        assert_eq!(
            free_path(dir.path(), "clip.mp4", &pending).unwrap(),
            dir.path().join("clip.mp4")
        );
    }
}
