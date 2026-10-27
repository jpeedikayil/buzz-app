import { eventDto } from "../../src/features/relay/events";
import { schnorr } from "@noble/curves/secp256k1.js";
import { bytesToHex } from "nostr-tools/utils";
// Real ChannelsPage, thread reader, shared directory, panel registry and plugin lifecycle.
// Only the transport is synthetic. No dev broker, saved identity or live relay.
import { StrictMode, useLayoutEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { Context } from "@deepseek-ai/cordis";
import { createPluginManager } from "../../src/plugins/manager";
import { bundledPlugins } from "../../src/bundled";
import {
  PanelsService,
  type PanelContext,
  type PanelProps,
} from "../../src/features/panels/service";
import { PagesService } from "../../src/features/pages/service";
import { ChannelWorkspaceFixture } from "./channel-workspace";
import { createRelaySession } from "../../src/features/relay/session";
import { localAgentsFixture } from "../../src/features/agents/local-testing";
import { AgentsService } from "../../src/features/agents/service";
import { provideNavigation } from "../../src/features/navigation/service";
import type {
  RelayData,
  RelaySnapshot,
} from "../../src/features/relay/service";
import {
  bounds,
  keypair,
  message,
  profile,
  roster,
  signed,
  summary,
} from "../../src/features/relay/testing";
import { profileTarget } from "../../src/features/profiles/target";
import { isUnreadWindowBatch } from "../../src/features/relay/unread-window-batch";
import { ToastProvider } from "../../src/shared/design-system/ui/Toast";
import "../../src/shared/styles/globals.css";
import { createAppearance } from "../../src/shared/theme/service";
import { SOLO_LABEL } from "../../src/features/solo/labels";
import { emptySync } from "../../src/features/communities/known-communities";
import type { ClientSnapshot } from "../../src/features/communities/service";

createAppearance();
const soloProbe = new URLSearchParams(location.search).has("solo");

const viewer = keypair(),
  authority = keypair(),
  mic = keypair(),
  pinky = keypair(),
  missing = keypair();
const fixtureOrigin = "https://relay.example.test";
// Pinky is one of this machine's own agents in this community.
const localAgentProbe = new URLSearchParams(location.search).has("local-agent");
const memberMessageProbe = new URLSearchParams(location.search).has(
  "member-message",
);
let dmOpened = false;
const dmOpens: string[][] = [];
const dmEvents = () => [
  signed(authority, {
    kind: 39000,
    content: "",
    tags: [
      ["d", "member-dm"],
      ["t", "dm"],
      ["name", "Member conversation"],
    ],
  }),
  roster(authority, "member-dm", [viewer.pubkey, mic.pubkey]),
];
const root = message(viewer, "one", "Hello @Mic", 10, [["p", mic.pubkey]]);
const unknown = signed(missing, {
  kind: 40002,
  content: "Unknown author",
  created_at: 11,
  tags: [["h", "one"]],
});
const reply = message(viewer, "one", "Thread @Pinky", 12, [
  ["e", root.id, "", "reply"],
  ["p", pinky.pubkey],
]);
const picture = "https://images.test/avatar.png";
const pinkyPicture = "https://images.test/pinky-animated.gif";
const pictureFixture = "/tests/fixtures/design-system/assets/avatar.png";
const pinkyPictureFixture = "/tests/fixtures/design-system/assets/avatar.png";
const report = {
  profileReads: [] as string[][],
  media: [] as [string, "small" | undefined][],
  publications: 0,
};
let failMissing = true;
let replyGate: Promise<void> | undefined;
let releaseReply = () => {};
let replyPending = false;
let data = [
  profile(viewer, { name: "Viewer", about: "Human profile", picture }),
  profile(mic, { name: "Mic", about: "Mic biography" }),
  signed(pinky, {
    kind: 0,
    content: JSON.stringify({
      name: "Pinky",
      nip05: "pinky@example.test",
      about: "Agent profile",
      is_agent: true,
      picture: pinkyPicture,
    }),
    tags: [],
  }),
];
async function attestAgentProfile() {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`nostr:agent-auth:${pinky.pubkey}:`),
  );
  const ownerSignature = bytesToHex(
    schnorr.sign(new Uint8Array(digest), viewer.secret),
  );
  data = data.map((head) =>
    head.pubkey === pinky.pubkey
      ? signed(pinky, {
          kind: 0,
          content: head.content,
          tags: [["auth", viewer.pubkey, "", ownerSignature]],
        })
      : head,
  );
}
function session() {
  return createRelaySession(
    {
      viewer: viewer.pubkey,
      ...(localAgentProbe ? { scope: fixtureOrigin } : {}),
      ...(memberMessageProbe
        ? {
            openDirectMessage: async (keys: readonly string[]) => {
              dmOpens.push([...keys]);
              dmOpened = true;
              return "member-dm";
            },
            writer: {
              kinds: [9],
              sign: async (template: Parameters<typeof signed>[1]) =>
                signed(viewer, template),
              publish: async () => {
                report.publications++;
              },
            },
          }
        : {}),
      ...(new URLSearchParams(location.search).has("verified-name")
        ? {
            verifiedProfiles: {
              pubkey: authority.pubkey,
              multipleIssuers: false,
            },
            readVerifiedProfileAuthority: async () => null,
          }
        : {}),
      relayAuthor: authority.pubkey,
      subscribe(callbacks) {
        callbacks.state({ status: "connected", routes: [] });
        return {
          update() {},
          retry() {},
          dispose() {},
          syncVerifiedProfiles(_filter, sink) {
            sink.event(
              eventDto(
                signed(authority, {
                  kind: 30382,
                  content: "",
                  tags: [
                    ["d", viewer.pubkey],
                    ["p", viewer.pubkey],
                    ["active", "true"],
                    ["display_name", "Viewer"],
                    ["username", "viewer"],
                    ["issuer_label", "Example"],
                    ["verified_at", "1000000"],
                    ...(new URLSearchParams(location.search).has("no-full-name")
                      ? []
                      : [["full_name", "Viewer Example"]]),
                  ],
                }),
              ),
            );
            sink.eose();
            return () => {};
          },
        };
      },
      media: (url, size) => {
        report.media.push([url, size]);
        return url === picture
          ? pictureFixture
          : url === pinkyPicture
            ? pinkyPictureFixture
            : url;
      },
      async query(filters) {
        if (
          replyGate &&
          filters.some((filter) => filter.ids?.includes(reply.id))
        ) {
          replyPending = true;
          await replyGate;
        }
        return filters.flatMap((filter) => {
          if (dmOpened && filter["#d"]?.includes("member-dm"))
            return dmEvents().filter((event) =>
              filter.kinds?.includes(event.kind),
            );
          if (filter.kinds?.includes(9) && filter["#h"]?.includes("member-dm"))
            return [
              bounds(authority, "member-dm", "head", {
                has_more: false,
                next_cursor: null,
              }),
            ];
          if (filter.kinds?.includes(39002))
            return [
              roster(authority, "one", [
                viewer.pubkey,
                mic.pubkey,
                pinky.pubkey,
              ]),
              roster(authority, "two", [viewer.pubkey]),
            ];
          if (filter.kinds?.includes(39000))
            return [
              signed(authority, {
                kind: 39000,
                content: JSON.stringify({ name: "One" }),
                tags: [
                  ["d", "one"],
                  ["name", "One"],
                  ["t", "stream"],
                  ...(soloProbe ? [["private"], ["t", SOLO_LABEL]] : []),
                ],
              }),
              signed(authority, {
                kind: 39000,
                content: JSON.stringify({ name: "Two" }),
                tags: [
                  ["d", "two"],
                  ["name", "Two"],
                  ["t", "stream"],
                ],
              }),
            ];
          if (
            filter.kinds?.includes(30315) &&
            filter.authors?.includes(viewer.pubkey) &&
            new URLSearchParams(location.search).has("long-status")
          )
            return [
              signed(viewer, {
                kind: 30315,
                content: "Working EST hours until Oct 23",
                tags: [
                  ["d", "general"],
                  ["emoji", "🇺🇸"],
                ],
              }),
            ];
          if (filter.kinds?.includes(30315))
            return filter.authors?.includes(mic.pubkey)
              ? [
                  signed(mic, {
                    kind: 30315,
                    content: "In a meeting",
                    tags: [
                      ["d", "general"],
                      ["emoji", "📅"],
                    ],
                  }),
                ]
              : [];
          if (filter.kinds?.includes(0)) {
            report.profileReads.push([...(filter.authors ?? [])]);
            if (
              failMissing &&
              filter.authors?.length === 1 &&
              filter.authors[0] === missing.pubkey
            )
              throw new Error("Fixture profile failure");
            return data.filter((event) =>
              filter.authors?.includes(event.pubkey),
            );
          }
          if (filter.ids)
            return [root, unknown, reply].filter((event) =>
              filter.ids?.includes(event.id),
            );
          if (filter.depth_limit) return [reply];
          // The unread repair's channel windows, authored page and thread
          // reads find no activity here, as its former single evidence query
          // did not: the fixture's channels carry no unread badge.
          if (isUnreadWindowBatch([filter])) return [];
          if (filter.kinds?.includes(9))
            return filter["#h"]?.includes("two")
              ? [
                  bounds(authority, "two", "head", {
                    has_more: false,
                    next_cursor: null,
                  }),
                ]
              : [
                  root,
                  unknown,
                  summary(authority, "one", root.id, {
                    reply_count: 1,
                    participants: [viewer.pubkey],
                  }),
                  bounds(authority, "one", "head", {
                    has_more: false,
                    next_cursor: null,
                  }),
                ];
          return [];
        });
      },
    },
    localAgentProbe
      ? {
          agentChoices: localAgentsFixture([
            {
              pubkey: pinky.pubkey,
              name: "Pinky",
              relayUrl: fixtureOrigin,
              owner: viewer.pubkey,
            },
          ]),
        }
      : {},
  );
}
let owner = session();
let snapshot: RelaySnapshot = {
  status: "ready",
  generation: 1,
  scope: `${fixtureOrigin}:${viewer.pubkey}`,
  viewer: viewer.pubkey,
  session: owner.session,
};
const listeners = new Set<() => void>();
const relay: RelayData = {
  snapshot: () => snapshot,
  subscribe(listener) {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
  retry() {},
  disconnect() {},
  clearCache: () => owner.clearCache(),
};
const context = new Context();
context.provide("relay", relay);
const communitySnapshot: ClientSnapshot = {
  status: "ready",
  relayAvailable: true,
  viewer: viewer.pubkey,
  profile: { name: "Viewer", picture },
  memberships: [{ id: fixtureOrigin, name: "Fixture community" }],
  selected: fixtureOrigin,
  sync: emptySync(),
};
context.provide("communityReader", {
  snapshot: () => communitySnapshot,
  subscribe: () => () => {},
});
const navigationHost = provideNavigation(context, undefined);
const contexts: PanelContext[] = [];
function ContextProbe({ context }: PanelProps) {
  useLayoutEffect(() => {
    if (context && contexts.at(-1) !== context) contexts.push(context);
  }, [context]);
  return <p>Context probe</p>;
}
const probing = new URLSearchParams(location.search).has("context-probe");
const manager = createPluginManager(context, {
  bundled: probing
    ? [
        {
          manifest: {
            id: "context.probe",
            name: "Context probe",
            apiVersion: 1,
          },
          module: {
            inject: ["panels"],
            apply(ctx) {
              ctx.panels.register({
                id: "probe",
                title: "Context probe",
                matches: (target) => target.startsWith("nostr:"),
                component: ContextProbe,
              });
            },
          },
        },
      ]
    : bundledPlugins.filter(({ manifest }) => manifest.id === "buzz.profiles"),
});
const panels = new PanelsService(context);
// Profiles reads Agents to choose agent tabs; this fixture has no agents.
new AgentsService(context, relay, undefined);
const pages = new PagesService(context);
Object.assign(window, {
  profilesFixture: {
    report,
    messages: { root: root.id, reply: reply.id },
    holdReply() {
      replyPending = false;
      replyGate = new Promise<void>((resolve) => {
        releaseReply = resolve;
      });
    },
    replyPending: () => replyPending,
    releaseReply() {
      replyGate = undefined;
      releaseReply();
    },
    navigation: context.navigation,
    contexts,
    dmOpens,
    targets: {
      viewer: profileTarget(viewer.pubkey),
      mic: profileTarget(mic.pubkey),
    },
    disconnect() {
      snapshot = { ...snapshot, status: "disconnected" };
      for (const listener of listeners) listener();
    },
    npubs: Object.fromEntries(
      Object.entries({ viewer, mic, pinky, missing }).map(([name, key]) => [
        name,
        profileTarget(key.pubkey)?.slice(6),
      ]),
    ),
    keys: {
      viewer: viewer.pubkey,
      mic: mic.pubkey,
      pinky: pinky.pubkey,
      missing: missing.pubkey,
    },
    change: manager.change,
    recover() {
      failMissing = false;
      data.push(
        profile(missing, { name: "Recovered", about: "Recovered biography" }),
      );
    },
    replace() {
      owner.dispose();
      owner = session();
      snapshot = {
        ...snapshot,
        generation: snapshot.generation + 1,
        session: owner.session,
      };
      for (const listener of listeners) listener();
    },
  },
});
function Fixture() {
  const [dark, setDark] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => {
          document.documentElement.dataset.colorMode = dark ? "light" : "dark";
          setDark(!dark);
        }}
      >
        Toggle appearance
      </button>
      <div
        style={{
          height: "calc(100vh - 50px)",
          padding: 16,
          width: soloProbe ? "calc(100% - 420px)" : undefined,
        }}
      >
        <ChannelWorkspaceFixture
          host={navigationHost}
          relay={relay}
          panels={panels}
          pages={pages}
        />
      </div>
    </>
  );
}
await attestAgentProfile();
const element = document.getElementById("root");
if (!element) throw new Error("Missing root");
createRoot(element).render(
  <StrictMode>
    <ToastProvider>
      <Fixture />
    </ToastProvider>
  </StrictMode>,
);
