import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { defineConfig, loadEnv, type PluginOption } from "vite";
import react from "@vitejs/plugin-react";
import { worktreePort } from "./scripts/worktree-port.mjs";
import {
  parseCommunityAliases,
  relayOrigin,
} from "./src/features/communities/destination.ts";
import { parseFirstRunAccountSeed } from "./src/features/identity/first-run-seed.ts";

/** `BUZZ_BUILDERLAB_URL` from the process or `.env.local`, or undefined when unset. */
function sharedBuilderlabUrl() {
  const key = "BUZZ_BUILDERLAB_URL";
  if (process.env[key] !== undefined) return process.env[key];
  let local: string;
  try {
    local = readFileSync(resolve(".env.local"), "utf8");
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    )
      return undefined;
    throw new Error("Could not read shared Builderlab build configuration.");
  }
  return parseEnv(local.replace(/^\uFEFF/, ""))[key];
}

/** The built-in sign-in server's Builderlab, in the legacy URL's shape. Keep
 * in step with `BUILT_IN` in src-tauri/src/federated_identity/config.rs. */
const BUILT_IN_BUILDERLAB = "https://app.builderlab.xyz";

function isBuiltInBuilderlab(raw: string) {
  try {
    const url = new URL(raw);
    return (
      url.origin === BUILT_IN_BUILDERLAB &&
      url.pathname.replace(/\/+$/, "") === "" &&
      !url.search &&
      !url.hash
    );
  } catch {
    return false;
  }
}

/** An FI build signs in to Builderlab through its first sign-in server's
 * identity origin and API base, in the legacy URL's shape
 * (`<url>/api/goose/`). This applies native's rule (`compiled` in
 * federated_identity/config.rs): unset adds nothing to the built-in server,
 * empty opts out, and a Builderlab URL for another deployment turns the
 * built-in server off. Native builds read the descriptor from the process
 * only, and so does this. */
function federatedBuilderlabUrl(legacy: string | undefined) {
  const raw = process.env.BUZZ_BUILD_FEDERATED_IDENTITY_CONFIG;
  if (raw === "") return undefined;
  if (raw === undefined)
    return legacy === undefined
      ? BUILT_IN_BUILDERLAB
      : isBuiltInBuilderlab(legacy)
        ? legacy
        : undefined;
  const parsed = JSON.parse(raw) as unknown;
  const { identityOrigin, apiBasePath } = (
    Array.isArray(parsed) ? parsed[0] : parsed
  ) as {
    identityOrigin?: unknown;
    apiBasePath?: unknown;
  };
  // Another API shape is not Builderlab's: its sign-in stays unconfigured.
  if (
    typeof identityOrigin !== "string" ||
    typeof apiBasePath !== "string" ||
    !apiBasePath.endsWith("/api/goose/")
  )
    return "";
  return `${new URL(identityOrigin).origin}${apiBasePath.slice(0, -"/api/goose/".length)}`;
}

export default defineConfig(async ({ command, mode }) => {
  const env = loadEnv(mode, ".", "BUZZ_");
  // Native builds consume only process values and repository-root .env.local.
  // Keep this frontend value on the same source so Vite mode files cannot
  // select a different same-origin deployment path.
  const legacyUrl = sharedBuilderlabUrl();
  const federatedUrl = federatedBuilderlabUrl(legacyUrl);
  const builderlabUrl = federatedUrl ?? legacyUrl ?? BUILT_IN_BUILDERLAB;
  // The development broker is the dev server's default: it runs whenever the
  // developer has pinned their public key. Production builds (`pnpm build`,
  // `pnpm tauri build`) never load it, regardless of .env.local contents.
  const live = command === "serve" && Boolean(env.BUZZ_DEV_VIEWER?.trim());
  const aliases = env.BUZZ_COMMUNITY_ALIASES ?? "";
  parseCommunityAliases(aliases);
  const externalMcpCommunities = (env.BUZZ_EXTERNAL_MCP_COMMUNITIES ?? "")
    .split(/\s+/)
    .filter(Boolean)
    .map(relayOrigin)
    .join(" ");
  // Public routing configuration only; the viewer pin and credentials stay in Node.
  const defaultRelay = env.BUZZ_RELAY_URL?.trim();
  const defaultOrigin = defaultRelay ? relayOrigin(defaultRelay) : "";
  // Opt-in seed: a viewer with no saved client record on this dev origin starts
  // in the default relay's community. The legacy alias is presence-only; an
  // explicit dev setting wins (only "1" enables it). Builds never see it.
  const openRelay =
    live &&
    (env.BUZZ_DEV_OPEN_RELAY !== undefined
      ? env.BUZZ_DEV_OPEN_RELAY === "1"
      : env.BUZZ_BUILD_AUTO_CONNECT_DEFAULT_RELAY !== undefined);
  if (openRelay && !defaultOrigin)
    throw new Error(
      "BUZZ_DEV_OPEN_RELAY=1 requires BUZZ_RELAY_URL to name the community to open.",
    );
  // Packagers may seed a community for a viewer with no saved client record.
  // Keep this separate from the live development broker and its opt-in flags.
  const packagedRelay =
    command === "build" ? env.BUZZ_DEFAULT_COMMUNITY_URL?.trim() : "";
  const openOrigin = packagedRelay
    ? relayOrigin(packagedRelay)
    : openRelay
      ? defaultOrigin
      : "";
  // Packagers may point the bundled goose's Databricks provider at a workspace.
  const databricksHost = env.BUZZ_DATABRICKS_HOST?.trim() ?? "";
  if (databricksHost) {
    const url = URL.canParse(databricksHost) ? new URL(databricksHost) : null;
    if (url?.protocol !== "https:" || url.username || url.password)
      throw new Error(
        "BUZZ_DATABRICKS_HOST must be an https:// URL without credentials.",
      );
  }
  // Opt-in seed: replaces first run's Builderlab account requests, key backup
  // and recovery, so the first-run screens can be walked against a real account
  // whose binding must not change. Builds never see it. The full list is in
  // docs/configuration.md#first-run-account-seed-development.
  const firstRunAccount =
    command === "serve" ? (env.BUZZ_DEV_FIRST_RUN_ACCOUNT ?? "") : "";
  parseFirstRunAccountSeed(firstRunAccount);
  const plugins: PluginOption[] = [react()];
  if (command === "serve")
    plugins.push(
      (await import("./scripts/developer-settings.ts")).developerSettingsPlugin(
        process.cwd(),
      ),
    );
  if (live)
    plugins.push(
      (await import("./browser-host/relay-broker.mjs")).relayBrokerPlugin({
        authorizedViewer: env.BUZZ_DEV_VIEWER,
        relayUrl: defaultRelay,
        communityAliases: aliases,
        builderlab: {
          api: `${builderlabUrl.replace(/\/$/, "")}/api/goose`,
          appsBase: (
            await import("./src/bundled/builderlab/apps/environment.ts")
          ).controlPlane(builderlabUrl),
        },
      }),
    );
  const profileReadyToken = process.env.BUZZ_PROFILE_VITE_READY_TOKEN;
  if (profileReadyToken)
    plugins.push({
      name: "buzz-profile-ready",
      configureServer(server) {
        server.httpServer?.once("listening", () => {
          const address = server.httpServer?.address();
          if (address && typeof address === "object")
            console.log(
              `BUZZ_PROFILE_VITE_READY:${profileReadyToken}:${JSON.stringify(address)}`,
            );
        });
      },
    });
  return {
    plugins,
    define: {
      "import.meta.env.VITE_BUZZ_LIVE": JSON.stringify(live ? "1" : "0"),
      "import.meta.env.VITE_BUZZ_NOTIFICATIONS_PAUSED": JSON.stringify(
        command === "serve" && env.BUZZ_DEV_NOTIFICATIONS === "0" ? "1" : "0",
      ),
      "import.meta.env.VITE_BUZZ_COMMUNITY_ALIASES": JSON.stringify(aliases),
      "import.meta.env.VITE_BUZZ_EXTERNAL_MCP_COMMUNITIES": JSON.stringify(
        externalMcpCommunities,
      ),
      "import.meta.env.VITE_BUZZ_BUILDERLAB_URL": JSON.stringify(builderlabUrl),
      "import.meta.env.VITE_BUZZ_FEDERATED_IDENTITY": JSON.stringify(
        federatedUrl === undefined ? "0" : "1",
      ),
      "import.meta.env.VITE_BUZZ_BUILDERLAB_APPS_DOMAIN":
        JSON.stringify(env.BUZZ_BUILDERLAB_APPS_DOMAIN) ?? "undefined",
      "import.meta.env.VITE_BUZZ_OPEN_RELAY": JSON.stringify(openOrigin),
      "import.meta.env.VITE_BUZZ_DATABRICKS_HOST":
        JSON.stringify(databricksHost),
      "import.meta.env.VITE_BUZZ_FIRST_RUN_ACCOUNT":
        JSON.stringify(firstRunAccount),
    },
    build: {
      rollupOptions: {
        input: {
          main: fileURLToPath(new URL("index.html", import.meta.url)),
          huddle: fileURLToPath(new URL("huddle.html", import.meta.url)),
        },
      },
    },
    clearScreen: false,
    // Keep build artifacts and coverage pages out of dependency discovery.
    optimizeDeps: {
      entries: ["**/*.html", "!**/target/**", "!**/coverage/**"],
    },
    server: {
      // Derived from this checkout's path, exactly as `just desktop` does, so
      // each worktree has its own stable default. The CLI's --port still wins.
      port: worktreePort(fileURLToPath(new URL(".", import.meta.url))),
      strictPort: false,
      watch: { ignored: ["**/src-tauri/**", "**/target/**", "**/.scratch/**"] },
    },
  };
});
