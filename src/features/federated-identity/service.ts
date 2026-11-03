import { Service, type Context } from "@deepseek-ai/cordis";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { nativeIdentityEnabled } from "../identity/service";
import type { HostResponse } from "../host/service";

export type SessionSnapshot = Readonly<{
  status:
    | "unconfigured"
    | "signed-out"
    | "signing-in"
    | "restoring"
    | "signed-in"
    | "reauthentication-required"
    | "unavailable";
  authority: Readonly<{
    id: string;
    identityOrigin: string;
    apiBasePath: string;
    /** `at-launch` builds sign in before the app opens; see LaunchSignIn. */
    signIn: "on-demand" | "at-launch";
    /** Display name for sign-in copy, such as "Block". */
    organization: string | null;
  }> | null;
  revision: string;
  email: string | null;
  failure: string | null;
  /** When the signed-in session ends (RFC 3339). */
  expiresAt: string | null;
  /** The session ends soon; signing in again now keeps the app open. */
  expiring: boolean;
}>;
export type AuthenticatedRequest = Readonly<{
  path: string;
  method?: "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE";
  headers?: Readonly<Record<string, string>>;
  body?: string;
}>;
export interface FederatedIdentity {
  /** Granted routes are forwarded natively with the session as a Bearer token. */
  readonly apiAvailable: boolean;
  snapshot(): SessionSnapshot;
  subscribe(listener: () => void): () => void;
  signIn(): Promise<SessionSnapshot>;
  cancelSignIn(): Promise<void>;
  signOut(): Promise<void>;
  request(input: AuthenticatedRequest): Promise<HostResponse>;
  /** The session of the sign-in server for a community (`wss://` or
   * `https://` origin). Native chooses the server from the community's host,
   * never from the relay; it is this session for the build's Builderlab. */
  forCommunity?(relay: string): FederatedIdentity;
}
declare module "@deepseek-ai/cordis" {
  interface Context {
    federatedIdentity: FederatedIdentity;
  }
}

export class FederatedIdentityService
  extends Service
  implements FederatedIdentity
{
  readonly apiAvailable = nativeIdentityEnabled();
  private readonly shared = {
    snapshot: Object.freeze({
      status: nativeIdentityEnabled() ? "restoring" : "unavailable",
      authority: null,
      revision: "",
      email: null,
      failure: nativeIdentityEnabled() ? null : "desktop-required",
      expiresAt: null,
      expiring: false,
    }) as SessionSnapshot,
    listeners: new Set<() => void>(),
    epoch: 0,
    closed: false,
    communities: new Map<string, CommunitySession>(),
    // Keyed by the calling plugin's fiber: each `this.ctx` access is a new
    // object, while the fiber lasts exactly as long as the plugin.
    registrations: new WeakMap<Context["fiber"], Promise<string>>(),
  };
  constructor(ctx: Context) {
    super(ctx, "federatedIdentity");
    ctx.effect(() => () => {
      this.shared.closed = true;
      this.shared.listeners.clear();
    });
    ctx.effect(async () => {
      if (!nativeIdentityEnabled())
        return () => {
          this.shared.closed = true;
          this.shared.listeners.clear();
        };
      let unlisten: () => void = () => {};
      try {
        unlisten = await listen<SessionSnapshot>(
          "federated-identity",
          ({ payload }) => this.accept(payload),
        );
      } catch {
        this.accept({
          ...this.shared.snapshot,
          status: "unavailable",
          failure: "native-unavailable",
        });
        return () => {
          this.shared.closed = true;
          this.shared.listeners.clear();
        };
      }
      const epoch = this.shared.epoch;
      try {
        const snapshot = await invoke<SessionSnapshot>(
          "federated_identity_snapshot",
        );
        if (this.shared.epoch === epoch) this.accept(snapshot);
      } catch {
        if (this.shared.epoch === epoch)
          this.accept({
            ...this.shared.snapshot,
            status: "unavailable",
            failure: "native-unavailable",
          });
      }
      return () => {
        this.shared.closed = true;
        unlisten();
        this.shared.listeners.clear();
      };
    });
  }
  private accept(snapshot: SessionSnapshot) {
    if (this.shared.closed) return;
    this.shared.epoch++;
    this.shared.snapshot = Object.freeze(snapshot);
    for (const listener of this.shared.listeners) listener();
  }
  snapshot = () => this.shared.snapshot;
  subscribe = (listener: () => void) => {
    this.shared.listeners.add(listener);
    return () => {
      this.shared.listeners.delete(listener);
    };
  };
  private async operation(command: string) {
    if (!nativeIdentityEnabled() || this.shared.closed)
      throw new Error("Federated identity requires Buzz desktop");
    const epoch = this.shared.epoch;
    try {
      const snapshot = await invoke<SessionSnapshot>(command);
      if (this.shared.epoch === epoch) this.accept(snapshot);
      return this.shared.snapshot;
    } catch (error) {
      throw typeof error === "string" ? new Error(error) : error;
    }
  }
  signIn() {
    return this.operation("federated_identity_sign_in");
  }
  async signOut() {
    await this.operation("federated_identity_sign_out");
  }
  async cancelSignIn() {
    if (!nativeIdentityEnabled() || this.shared.closed)
      throw new Error("Federated identity requires Buzz desktop");
    await invoke("federated_identity_cancel_sign_in");
    await this.operation("federated_identity_snapshot");
  }
  forCommunity = (relay: string): FederatedIdentity => {
    let session = this.shared.communities.get(relay);
    if (!session) {
      session = new CommunitySession(relay);
      this.shared.communities.set(relay, session);
    }
    return session;
  };
  async request(request: AuthenticatedRequest): Promise<HostResponse> {
    const owner = this.ctx.pluginOwner;
    if (!owner || !nativeIdentityEnabled() || this.shared.closed)
      throw new Error(
        "Authenticated requests require an active desktop plugin",
      );
    // The account this call started under; native refuses another's token.
    const session = this.shared.snapshot.revision;
    for (let attempt = 0; ; attempt++) {
      const registration = this.registration(owner);
      try {
        return await invoke<HostResponse>("federated_identity_request", {
          id: owner.id,
          revision: owner.revision,
          registration: await registration,
          session,
          request,
        });
      } catch (error) {
        // Native retires registrations around every plugin lifecycle change,
        // even a refused one or one still being admitted. Register again
        // once; admission rechecks the artifact and grant. A disposed fiber
        // rejects with an Error, not this string, so it is not retried.
        if (error === "Plugin registration retired") {
          if (this.shared.registrations.get(this.ctx.fiber) === registration)
            this.shared.registrations.delete(this.ctx.fiber);
          if (attempt === 0) continue;
        }
        throw typeof error === "string" ? new Error(error) : error;
      }
    }
  }
  private registration(owner: Readonly<{ id: string; revision: string }>) {
    const fiber = this.ctx.fiber;
    const cached = this.shared.registrations.get(fiber);
    if (cached) return cached;
    const token = crypto.randomUUID();
    let active = true;
    // Installed before native admission, so a disposed fiber, even one
    // retrying a retirement, throws here instead of registering again.
    this.ctx.effect(() => () => {
      active = false;
      if (this.shared.registrations.get(fiber) === registration)
        this.shared.registrations.delete(fiber);
      void invoke("federated_identity_unregister", {
        registration: token,
      }).catch(() => {});
    });
    const registration: Promise<string> = invoke<void>(
      "federated_identity_register",
      {
        id: owner.id,
        revision: owner.revision,
        registration: token,
      },
    )
      .then(() => {
        if (!active) {
          void invoke("federated_identity_unregister", {
            registration: token,
          }).catch(() => {});
          throw new Error("Plugin registration retired");
        }
        return token;
      })
      .catch((error) => {
        if (this.shared.registrations.get(fiber) === registration)
          this.shared.registrations.delete(fiber);
        throw error;
      });
    this.shared.registrations.set(fiber, registration);
    return registration;
  }
}

const EVENTS = ["federated-identity", "federated-identity-community"];

/** One community's sign-in server session, for its sign-in prompt. Snapshots
 * follow its server, whichever event stream native publishes them on. */
class CommunitySession implements FederatedIdentity {
  readonly apiAvailable = false;
  private state: SessionSnapshot = Object.freeze({
    status: "restoring",
    authority: null,
    revision: "",
    email: null,
    failure: null,
    expiresAt: null,
    expiring: false,
  }) as SessionSnapshot;
  private readonly listeners = new Set<() => void>();
  private started = false;
  private epoch = 0;
  constructor(private readonly relay: string) {}
  private accept(snapshot: SessionSnapshot) {
    this.epoch++;
    this.state = Object.freeze(snapshot);
    for (const listener of this.listeners) listener();
  }
  private start() {
    if (this.started || !nativeIdentityEnabled()) return;
    this.started = true;
    for (const event of EVENTS)
      void listen<SessionSnapshot>(event, ({ payload }) => {
        const id = this.state.authority?.id;
        if (id && payload.authority?.id === id) this.accept(payload);
      }).catch(() => {});
    void this.operation("federated_identity_snapshot").catch(() => {});
  }
  snapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.start();
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private async operation(command: string) {
    if (!nativeIdentityEnabled())
      throw new Error("Federated identity requires Buzz desktop");
    const epoch = this.epoch;
    try {
      const snapshot = await invoke<SessionSnapshot>(command, {
        relay: this.relay,
      });
      if (this.epoch === epoch) this.accept(snapshot);
      return this.state;
    } catch (error) {
      throw typeof error === "string" ? new Error(error) : error;
    }
  }
  signIn() {
    return this.operation("federated_identity_sign_in");
  }
  async signOut() {
    await this.operation("federated_identity_sign_out");
  }
  async cancelSignIn() {
    await invoke("federated_identity_cancel_sign_in", { relay: this.relay });
    await this.operation("federated_identity_snapshot");
  }
  request(): Promise<HostResponse> {
    return Promise.reject(
      new Error("Authenticated requests use the Builderlab session"),
    );
  }
}

/** `onSignedIn` for every sign-in server but the build's Builderlab. */
export function onCommunitySignedIn(reauthorize: () => void) {
  if (!nativeIdentityEnabled()) return () => {};
  const previous = new Map<string, SessionSnapshot>();
  const unlisten = listen<SessionSnapshot>(
    "federated-identity-community",
    ({ payload }) => {
      const id = payload.authority?.id;
      if (!id || payload.status === "restoring") return;
      const before = previous.get(id);
      previous.set(id, payload);
      if (
        payload.status === "signed-in" &&
        before !== undefined &&
        (before.status !== "signed-in" || before.revision !== payload.revision)
      )
        reauthorize();
    },
  ).catch(() => () => {});
  return () => void unlisten.then((stop) => stop());
}

/** Calls `reauthorize` when the session, or any other sign-in server's,
 * becomes signed in or changes account, so every relay read it refused
 * retries at once instead of waiting for a manual Retry. Startup restore is
 * not a change: nothing was refused for it. */
export function onSignedIn(
  identity: FederatedIdentity,
  reauthorize: () => void,
) {
  const others = onCommunitySignedIn(reauthorize);
  let previous = identity.snapshot();
  const unsubscribe = identity.subscribe(() => {
    const next = identity.snapshot();
    // Keep the state before recovery; only startup itself begins as restoring.
    if (next.status === "restoring") return;
    const changed =
      next.status === "signed-in" &&
      previous.status !== "restoring" &&
      (previous.status !== "signed-in" || previous.revision !== next.revision);
    previous = next;
    if (changed) reauthorize();
  });
  return () => {
    unsubscribe();
    others();
  };
}
