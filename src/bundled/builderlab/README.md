# Builderlab

One Builderlab account for communities and agents that Builderlab hosts for you, so they keep working even when Buzz is closed.

## Getting started

1. Go to **Settings → Plugins → Builderlab** and choose **Sign in with Builderlab**.
2. To host a community, choose **Create community** under **Communities**, then **Copy address**, open the community picker and choose **Join a community**.
3. To host an agent, in **Agents** choose **New agent** and pick **Builderlab (hosted)** as the **Harness**.
4. Choose a model and thinking level, optionally add instructions, then create the agent.
5. Edit model settings and instructions later in **Identity**.

---

# Builderlab

## Apps pilot

Local agents can create, deploy, inspect readiness, share and open Apps Platform
apps using the Settings Builderlab sign-in. `apps_contract` reports the selected
tenant's runtimes and schema location. Creation checks that contract and supports
`static` and `fetch-js`; it repeats the selected runtime through reservation and
initialization. The executable profile returns the required asset manifest and
bindings, even when its handler serves all content itself.

Sharing follows the one-workspace model: `apps_visibility` switches an app
between everyone in the owner's workspace and only the owner, and
`apps_community` grants or revokes a Buzz community at the grant revision it just
read. `apps_visibility` keeps existing viewers and community grants.

BBBlock is the employee pilot. BBPublic uses the same authenticated control-plane
boundary: the server must grant Builderlab access to the current workspace/account.
Existing workspace early-preview enablement can provide that access; these tools
do not enable a workspace or bypass its policy. A denied request preserves the
server's permission error. Check the contract before choosing a profile because
BBPublic need not support static hosting.

After an accepted deployment, readiness errors preserve its app, version,
deployment and rollout IDs. `apps_status` checks those exact IDs without uploading
again. A failed reservation or initialization names the planned app ID; inspect or
resume that app before creating another one. Automatic reservation recovery and
hosted tool declarations are separate work.

The macOS app panel uses the Settings account for viewing. Native code exchanges
its CLI credential on the configured Builderlab API for a restricted viewer
credential and absolute expiry. Native code installs the HttpOnly/Secure viewer
cookie before opening the original app URL. The guest never receives the CLI
credential. App authorization and consent still run at ingress.
Opening a different tenant's app never forwards the current account's credential.

Each account has its own website storage, kept across sign-ins and restarts, so
an app's browser login persists while native exchange is unavailable. Signing out or changing accounts closes
live and retained guests; deliberate sign-out also requests revocation of the server CLI parent.
Canceling sign-in or disposing the plugin closes its local guests without logging
out an existing server session. Other platforms do not expose the app panel.
The server's native viewer feature must be enabled after its schema and auth
review; older CLI sessions without signed authentication time require a fresh
Settings login. This client change alone does not enable the server feature. Apps that require
pre-app consent still use the existing canonical browser authentication gate.

## Remote agents

The bundled `block.builderlab` plugin adds Settings → Plugins → Builderlab: one
sign-in, then hosted communities (`communities/`, see
[plugin architecture](../../../docs/plugin-architecture.md)) and remote agents.
With a configured Builderlab, it also registers
`block.builderlab/builderlab` in Agents' new-agent type picker.
`adapter-type/` connects this hosted type to Beekeeper: provision registers the
agent, activation submits the owner proof and community supplied by Agents, and
removal deletes the provider runtime. Agents owns unfinished setup recovery and
the runtime-tagged community registration; the provider keeps the key and runs
the agent even while Buzz is closed. On desktop, Create agent and confirmed
deletion start browser sign-in when needed, then continue the action. Both share
an existing Settings sign-in attempt; a failed or canceled login leaves the
action available for retry. Settings still provides sign-in and sign-out.
While Create agent waits for the browser, its dialog offers Cancel sign-in, which
cancels the shared login (as Settings' does) and leaves Create available for
retry. Deletion's wait has no such control; disabling the plugin or closing Buzz
also cancels it.
Beekeeper accepts an owner proof only from the Buzz key bound to the signed-in
Builderlab account. After sign-in, and again before each activation, the plugin
checks `/v1/buzz/nostr-identities/current` and binds an unbound account to this
device's key through the native kind 24243 signer, which accepts only
production Builderlab or this build's Builderlab origin. An account
bound to another key is reported and never unbound.
The agent's Identity tab reads its current instructions from Builderlab and
saves changes directly to the provider. Loading and saving use the same login;
failed saves keep the draft, and switching accounts requires the original
account before saving. A different signed-in account locks the fields and shows
that requirement instead of the previous account's errors and retries. Signed-out
panes hide stale settings errors and retries while retaining the draft.
Empty instructions can be saved to clear them.
Signed-out agent panes show a pinned sign-in card across every tab, including
relay-backed Memory and Activity. Opening the pane does not start browser login;
Sign in starts it, and Cancel sign-in cancels the shared account attempt.
The card reserves its measured height for scrolling and clears once sign-in is
verified. Slow settings/catalog reads offer a scoped retry after three seconds.
The Identity tab also loads a separate model catalog from Builderlab. Choose a
model and one of that model's thinking levels, then save the pair for new tasks.
There is no default or fallback selection. Missing or unavailable saved choices
show the server's setup status and require a supported pair. Changing the model
clears the effort choice. One shared Save action sits in the agent pane's bottom
footer and saves the Identity draft. When model settings and instructions both
change, they are sent in one update. While signed in to the original account,
Instructions alone remain editable when the model catalog is unavailable;
a changed model requires a supported effort before
the draft can be saved.
The model control uses the same family submenus as Goose. Builderlab's catalog
aliases are mapped to families in `adapter-type/models.ts`; update that mapping
with Builderlab's catalog information until its API supplies family metadata.
The server still owns available choices, names and thinking levels. Unmapped
aliases use shared family inference from the model ID and name; unrecognized
models remain selectable under Other. Families without a shared brand mark use
the generic model icon.
Creation offers the same catalog choices and optional instructions. The provider
registers and activates the agent before saving the settings together. Unfinished
setup retains these values on this device so retry continues the same agent,
including after a restart. Setup completes only once the settings save succeeds.
Settings shows the fixed remote workspace and per-thread session behavior, with
a link to the configured Builderlab site for remote runtime management.
Activity shows the turns the agent published to its owner while Buzz has been
open, across all of its conversations. It doesn't scope to the conversation it
was opened from, because hosted frames don't always name their thread. It needs
the Agent Activity plugin, which owns the feed.
Create sends the chosen picture with registration, and Beekeeper publishes it at
attestation. Renaming or changing the picture republishes the agent's profile
through Beekeeper's `update-agent-profile`.
While the hosted type is registered, the plugin also provides `ctx.builderlab`
so bundled consumers such as Bestie can set a hosted agent's model and
instructions with the same login. It offers only sign-in, the signed-in
account subject, list, the model catalog and those two updates; it never
exposes the credential or the Beekeeper client.

The adapter retains the provider agent ID, server, verified account subject and
provisioning replay reference in `buzz.builderlab.adapter-identity.v1:` records.
No credentials or owner proofs are saved. These records survive restart and
deletion so retries can confirm an already-missing runtime without assuming
absence from another account's list. Registration retains its replay UUID until
Agents has saved unfinished setup and begins activation, or provider deletion
is confirmed. On another device, removal resolves the ID from the signed-in
account's list; an unknown key is refused. Existing Settings-created
agents are not migrated into this type.

- `session.ts` is the `BuilderlabSession` consumers share. In an FI build it
  projects the native NIP-FI session: native holds the token in OS secure
  storage, so sign-in survives restart, and adds it as `Authorization: Bearer`
  to this plugin's granted routes. Each session revision reads its account from
  `/v1/auth/me`. A 401 refuses only that call; native then asks the adapter's
  `GET /v1/session` once and ends the session only if the adapter refuses it.
  Its sign-out lives in Identity → Organization sign-in, which `login/` links to,
  because community sign-in shares the session.
- `oauth/` owns browser handoff, code exchange, account verification, and the
  legacy plugin-lifetime session. `browserCredential()` returns a verified `Credential`;
  `session.credential()` provides access to it. The session handles cancellation,
  sign-out, and disposal.
  `oauth/first-run.ts` lets the app's first-launch welcome screen run the same
  sign-in before any plugin session exists, using this plugin's bundled native
  grant, at the build URL like the Settings card; that credential is separate
  from the Settings session. In an FI build it is the native NIP-FI sign-in
  instead, and the app's later calls go through the forwarder as this
  plugin's bundled installation (`bundledFederatedIdentity`). Either grant
  exists only while this plugin is enabled, so with it turned off that
  sign-in refuses before opening the browser.
  A successful first-run sign-in continues into the app-owned setup steps
  described in [identity](../../../docs/identity.md): the app reads the key
  bound to the account, the destinations saved to it (this plugin's
  known-communities list route, never through the Settings session's client)
  and the communities it owns through this plugin's bundled grant
  (`src/features/identity/builderlab-account.ts`, reusing the
  `communities/` routes and parsers); a linked account is asked for that
  key, otherwise the user creates a key or brings one they already have, and
  that key is then bound to the account through the same native signer and
  backed up (an imported key only once the user agrees);
  starting over creates a new key and unlinks the lost one before binding it.
  Key backup hands the sign-in to the native uploader, and the same portal is
  asked which keys the account holds a backup of; Welcome back
  restores the linked key from one through native recovery's own browser
  sign-in.
- `login/` owns the login experience: pending state, cancellation, retry, email
  display, and sign-out.
- `agents/` lists the signed-in account's remote agents beneath login, with
  refresh and retry. Settings directs people to the **Agents** tab to create,
  edit instructions and delete agents. Listing does not activate agents or
  publish community registrations. Requests go through `session.request`;
  sign-out and navigation discard late results.
  The client also supplies the hosted adapter's Beekeeper operations. Pending
  registration UUIDs survive restart, scoped to server, verified account and
  name. Retry the same name after an uncertain failure within the server's
  seven-day replay window. Instructions are limited to 20,000 characters,
  affect newly accepted tasks and are never published to the relay.
- `known-communities/` keeps the account's community list in step with this
  device through the `knownCommunities` capability while signed in, in native
  builds with a configured service. The list is an account-scoped set behind
  three idempotent JSON routes under `/v1/buzz/known-communities/`: `list`
  (`{}` → `{ communities: [{ community_url }] }`), `add` and `remove` (each
  `{ community_url }`; adding a saved destination or removing an absent one
  succeeds, and adds past about 1,000 saved destinations are refused with
  `limit_reached`). Each sign-in merges the complete list (adding what it
  lists; a saved membership it omits is kept and not uploaded again, since
  removals made on another device are ignored for now), then sends each
  destination's latest queued join or leave one at a time, retrying failures
  as sent. A list this client cannot read halts sync until the next sign-in,
  as does a 404 on any route (not yet deployed); a listed address the device
  could never save is dropped and counted, never a halt. See
  [communities](../../../docs/communities.md#known-communities).

The plugin's server is the build's Builderlab: its first
[sign-in server](../../../docs/configuration.md#federated-identity-build-input),
the built-in `https://app.builderlab.xyz` unless the build adds another, whose
native session it uses and which survives a restart. A build without one uses
the `BUZZ_BUILDERLAB_URL` [build input](../../../docs/configuration.md#builderlab-url-build-input)
as its server address, appends `/api/goose`, and keeps its sign-in in memory.

On desktop, the plugin supplies `/v1/auth/login` with `type=cli` and
`product=builderlab` to the shared native
[`oauth_callback` module](../../../src-tauri/src/oauth_callback/README.md).
Native code inserts a loopback `redirect_uri` address, opens the browser, and returns
callback parameters to the plugin. Native code generates and validates OAuth
state; the plugin also uses a random callback path.

Each attempt generates a random PKCE verifier held only in memory, sending its
SHA-256 challenge with `code_challenge_method=S256` during login. The plugin
posts the callback code and `code_verifier` to `/v1/auth/login/exchange`, then
verifies the returned session credential with `/v1/auth/me` using the
`X-BB-Session-Credential` header. These requests use the shared host transport.
The login snapshot retains `capabilities.can_use_remote_agents`; only explicit
`true` enables remote agents. Otherwise, Settings and the Agents provider show
“Coming soon” and no Beekeeper requests are sent. Sign out and back in to refresh
this capability.

The plugin also offers Builderlab as a Decisions API provider. It reads
`capabilities.can_use_builderlab_decisions` the same way, but only explicit
`true` registers the provider, and only while the user is signed in. Otherwise
Builderlab is not listed in Settings > Decisions API and no decision request
goes to it. While it is registered, it answers unless the user chose another
provider; when it goes away, TypeSafe answers. Sign out and back in to refresh
this capability. An FI build does not offer it: native `decide` sends the
legacy credential, which an FI build does not have.
