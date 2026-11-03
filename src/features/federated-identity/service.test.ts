import { Context } from "@deepseek-ai/cordis";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  FederatedIdentityService,
  onCommunitySignedIn,
  onSignedIn,
  type FederatedIdentity,
  type SessionSnapshot,
} from "./service";
import { federatedFixture } from "./testing";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), isTauri: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));
const signedOut: SessionSnapshot = {
  status: "signed-out",
  authority: {
    id: "test",
    identityOrigin: "https://identity.example",
    apiBasePath: "/api/",
    signIn: "on-demand",
    organization: null,
  },
  revision: "out",
  email: null,
  failure: null,
  expiresAt: null,
  expiring: false,
};
const signedIn: SessionSnapshot = {
  ...signedOut,
  status: "signed-in",
  revision: "in",
};
const roots: Context[] = [];
let publish: (event: { payload: SessionSnapshot }) => void;
let unlisten: ReturnType<typeof vi.fn<() => void>>;
beforeEach(() => {
  vi.mocked(isTauri).mockReturnValue(true);
  vi.mocked(invoke).mockReset().mockResolvedValue(signedOut);
  unlisten = vi.fn();
  vi.mocked(listen).mockImplementation(async (_name, handler) => {
    publish = handler as typeof publish;
    return unlisten;
  });
});
afterEach(async () => {
  for (const root of roots.splice(0)) await root.fiber.dispose();
  vi.unstubAllEnvs();
});
function setup() {
  const root = new Context();
  roots.push(root);
  const service = new FederatedIdentityService(root);
  return { root, service };
}
async function plugin(root: Context) {
  let service!: FederatedIdentity;
  const fiber = root
    .extend({ pluginOwner: { id: "example.plugin", revision: "artifact" } })
    .plugin({
      inject: ["federatedIdentity"],
      apply(ctx: Context) {
        service = ctx.federatedIdentity;
      },
    });
  await fiber;
  return { service, fiber };
}

it("keeps a native event newer than an in-flight restore and ignores delivery after disposal", async () => {
  let finish!: (snapshot: SessionSnapshot) => void;
  vi.mocked(invoke).mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const { root, service } = setup();
  await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
  try {
    const { snapshot, subscribe } = service;
    const changed = vi.fn();
    const release = subscribe(changed);
    publish({ payload: signedIn });
    expect(snapshot()).toBe(signedIn);
    expect(changed).toHaveBeenCalledOnce();
    release();
  } finally {
    finish(signedOut);
  }
  await vi.waitFor(() => expect(service.snapshot()).toBe(signedIn));
  await root.fiber.dispose();
  publish({ payload: signedOut });
  expect(service.snapshot()).toBe(signedIn);
  expect(unlisten).toHaveBeenCalledOnce();
  await expect(service.signIn()).rejects.toThrow("desktop");
});

it("fails closed when the native session event listener cannot be registered", async () => {
  vi.mocked(listen).mockRejectedValue(new Error("permission denied"));
  const { service } = setup();

  await vi.waitFor(() =>
    expect(service.snapshot()).toMatchObject({
      status: "unavailable",
      authority: null,
      failure: "native-unavailable",
    }),
  );
  expect(invoke).not.toHaveBeenCalledWith("federated_identity_snapshot");
});

it("reauthorizes on sign-in and account change, not on startup restore or sign-out", async () => {
  const h = federatedFixture();
  h.publish({ status: "restoring" });
  const reauthorize = vi.fn();
  const stop = onSignedIn(h.service, reauthorize);
  h.publish({ status: "signed-in", revision: "restored" });
  expect(reauthorize).not.toHaveBeenCalled();
  h.publish({ status: "signed-out" });
  expect(reauthorize).not.toHaveBeenCalled();
  await h.service.signIn();
  expect(reauthorize).toHaveBeenCalledTimes(1);
  h.publish({ email: "same@example.com" });
  expect(reauthorize).toHaveBeenCalledTimes(1);
  h.publish({ revision: "other-account" });
  expect(reauthorize).toHaveBeenCalledTimes(2);
  stop();
  await h.service.signIn();
  expect(reauthorize).toHaveBeenCalledTimes(2);
});

it("reauthorizes recovered sign-in once across restoring while keeping startup suppressed", () => {
  const h = federatedFixture();
  h.publish({ status: "restoring" });
  const reauthorize = vi.fn();
  const stop = onSignedIn(h.service, reauthorize);
  h.publish({ status: "signed-in", revision: "session" });
  expect(reauthorize).not.toHaveBeenCalled();
  h.publish({ status: "unavailable" });
  h.publish({ status: "restoring" });
  h.publish({ status: "signed-in", revision: "session" });
  expect(reauthorize).toHaveBeenCalledTimes(1);
  h.publish({ status: "restoring" });
  h.publish({ status: "signed-in", revision: "session" });
  expect(reauthorize).toHaveBeenCalledTimes(1);
  h.publish({ status: "restoring" });
  h.publish({ status: "signed-in", revision: "replacement" });
  expect(reauthorize).toHaveBeenCalledTimes(2);
  stop();
});

it("uses the caller's native grant registration, shares only public account state, and retries failed admission", async () => {
  const { root, service } = setup();
  const a = await plugin(root),
    b = await plugin(root);
  publish({ payload: signedIn });
  expect(a.service.snapshot()).toBe(service.snapshot());
  expect(b.service.snapshot()).toBe(service.snapshot());
  let rejected = false;
  vi.mocked(invoke).mockImplementation(async (command) => {
    if (command === "federated_identity_register" && !rejected) {
      rejected = true;
      throw "Plugin is disabled";
    }
    if (command === "federated_identity_request")
      return { status: 200, headers: {}, body: "{}" };
  });
  const request = { path: "/api/list", method: "POST" as const, body: "{}" };
  await expect(a.service.request(request)).rejects.toThrow("disabled");
  await expect(a.service.request(request)).resolves.toMatchObject({
    status: 200,
  });
  await b.service.request(request);
  const registrations = vi
    .mocked(invoke)
    .mock.calls.filter(([command]) => command === "federated_identity_register")
    .map(
      ([, args]) =>
        args as { id: string; revision: string; registration: string },
    );
  expect(registrations).toHaveLength(3);
  expect(new Set(registrations.map((item) => item.registration)).size).toBe(3);
  expect(
    registrations.every(
      (item) => item.id === "example.plugin" && item.revision === "artifact",
    ),
  ).toBe(true);
  await a.fiber.dispose();
  expect(invoke).toHaveBeenCalledWith("federated_identity_unregister", {
    registration: registrations[1]?.registration,
  });
  expect(b.service.snapshot().status).toBe("signed-in");
  await expect(service.request(request)).rejects.toThrow(
    "active desktop plugin",
  );
});

it("fences a request to the session it starts under and registers again once after native retires it", async () => {
  const { root } = setup();
  const a = await plugin(root);
  publish({ payload: signedIn });
  let retired = 0;
  vi.mocked(invoke).mockImplementation(async (command) => {
    if (command === "federated_identity_request" && retired++ < 2)
      throw "Plugin registration retired";
    if (command === "federated_identity_request")
      return { status: 200, headers: {}, body: "{}" };
  });
  const calls = (name: string) =>
    vi
      .mocked(invoke)
      .mock.calls.filter(([command]) => command === name)
      .map(([, args]) => args as { registration: string; session: string });
  // One retry: a second retirement in the same call is reported.
  await expect(a.service.request({ path: "/api/list" })).rejects.toThrow(
    "retired",
  );
  await expect(a.service.request({ path: "/api/list" })).resolves.toMatchObject(
    { status: 200 },
  );
  const requests = calls("federated_identity_request");
  expect(requests.map((call) => call.session)).toEqual(["in", "in", "in"]);
  expect(calls("federated_identity_register")).toHaveLength(3);
  expect(requests[2]?.registration).toBe(
    calls("federated_identity_register")[2]?.registration,
  );
});

it("registers again once when native retires the registration while admitting it", async () => {
  const { root } = setup();
  const a = await plugin(root);
  publish({ payload: signedIn });
  let retired = false;
  vi.mocked(invoke).mockImplementation(async (command) => {
    if (command === "federated_identity_register" && !retired) {
      retired = true;
      throw "Plugin registration retired";
    }
    if (command === "federated_identity_request")
      return { status: 200, headers: {}, body: "{}" };
  });
  await expect(a.service.request({ path: "/api/list" })).resolves.toMatchObject(
    { status: 200 },
  );
  const registrations = vi
    .mocked(invoke)
    .mock.calls.filter(([command]) => command === "federated_identity_register")
    .map(([, args]) => (args as { registration: string }).registration);
  expect(registrations).toHaveLength(2);
  expect(
    vi
      .mocked(invoke)
      .mock.calls.filter(
        ([command]) => command === "federated_identity_request",
      )
      .map(([, args]) => args as { registration: string; session: string }),
  ).toEqual([
    expect.objectContaining({ registration: registrations[1], session: "in" }),
  ]);
});

it("retries every in-flight request whose shared registration native retires", async () => {
  const { root } = setup();
  const a = await plugin(root);
  publish({ payload: signedIn });
  let first = "";
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command !== "federated_identity_request") return;
    const { registration } = args as { registration: string };
    first ||= registration;
    if (registration === first) throw "Plugin registration retired";
    return { status: 200, headers: {}, body: "{}" };
  });
  await expect(
    Promise.all([
      a.service.request({ path: "/api/list" }),
      a.service.request({ path: "/api/list" }),
    ]),
  ).resolves.toHaveLength(2);
});

it("does not register again when native retires an admission after plugin unload", async () => {
  const { root } = setup();
  const a = await plugin(root);
  let refuse!: () => void;
  vi.mocked(invoke).mockImplementation((command) =>
    command === "federated_identity_register"
      ? new Promise<void>((_, reject) => {
          refuse = () => reject("Plugin registration retired");
        })
      : Promise.resolve(undefined),
  );
  const request = a.service.request({ path: "/api/list" });
  await vi.waitFor(() => expect(refuse).toBeTypeOf("function"));
  await a.fiber.dispose();
  refuse();
  await expect(request).rejects.toThrow();
  const calls = (name: string) =>
    vi.mocked(invoke).mock.calls.filter(([command]) => command === name);
  expect(calls("federated_identity_register")).toHaveLength(1);
  expect(calls("federated_identity_request")).toHaveLength(0);
});

it("retires a registration admitted after plugin unload without forwarding the request", async () => {
  const { root } = setup();
  const a = await plugin(root);
  let finish!: () => void;
  vi.mocked(invoke).mockImplementation((command) =>
    command === "federated_identity_register"
      ? new Promise<void>((resolve) => {
          finish = resolve;
        })
      : Promise.resolve(undefined),
  );
  const request = a.service.request({ path: "/api/list" });
  await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
  await a.fiber.dispose();
  finish();
  await expect(request).rejects.toThrow("retired");
  expect(
    vi
      .mocked(invoke)
      .mock.calls.filter(
        ([command]) => command === "federated_identity_request",
      ),
  ).toHaveLength(0);
  expect(
    vi
      .mocked(invoke)
      .mock.calls.filter(
        ([command]) => command === "federated_identity_unregister",
      ),
  ).toHaveLength(2);
});

const peer = {
  id: "peer",
  identityOrigin: "https://peer.example",
  apiBasePath: "/api/",
  signIn: "on-demand",
  organization: null,
} as const;

it("signs in to a community's own server and follows only that server", async () => {
  const handlers = new Map<string, typeof publish>();
  vi.mocked(listen).mockImplementation(async (name, handler) => {
    handlers.set(name, handler as typeof publish);
    return unlisten;
  });
  const emit = (name: string, payload: SessionSnapshot) => {
    const handler = handlers.get(name);
    if (!handler) throw new Error(`No ${name} listener`);
    handler({ payload });
  };
  const { service } = setup();
  vi.mocked(invoke).mockResolvedValue({ ...signedOut, authority: peer });
  const community = service.forCommunity("wss://team.communities.example");
  expect(service.forCommunity("wss://team.communities.example")).toBe(
    community,
  );
  const changes = vi.fn();
  community.subscribe(changes);
  await vi.waitFor(() =>
    expect(community.snapshot().authority?.id).toBe("peer"),
  );
  expect(invoke).toHaveBeenCalledWith("federated_identity_snapshot", {
    relay: "wss://team.communities.example",
  });
  // Another server's snapshot is not this community's.
  emit("federated-identity", signedIn);
  expect(community.snapshot().status).toBe("signed-out");
  emit("federated-identity-community", { ...signedIn, authority: peer });
  expect(community.snapshot().status).toBe("signed-in");
  vi.mocked(invoke).mockResolvedValue({ ...signedIn, authority: peer });
  await community.signIn();
  expect(invoke).toHaveBeenCalledWith("federated_identity_sign_in", {
    relay: "wss://team.communities.example",
  });
});

it("reauthorizes communities when another server signs in", async () => {
  const reauthorize = vi.fn();
  onCommunitySignedIn(reauthorize);
  await vi.waitFor(() => expect(listen).toHaveBeenCalled());
  publish({ payload: { ...signedIn, authority: peer } });
  expect(reauthorize).not.toHaveBeenCalled();
  publish({ payload: { ...signedOut, authority: peer } });
  publish({ payload: { ...signedIn, authority: peer } });
  expect(reauthorize).toHaveBeenCalledTimes(1);
});
