// Real timeline, visit ownership and Virtua; synthetic unread evidence isolates layout.
import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { ChannelTimeline } from "../../src/features/messages/ChannelTimeline";
import { MessageManagement } from "../../src/features/messages/MessageManagement";
import { createRelaySession } from "../../src/features/relay/session";
import type {
  ChannelMessage,
  ChannelWindow,
} from "../../src/features/relay/contracts";
import { keypair } from "../../src/features/relay/testing";
import { readView, writeView } from "../../src/shared/view-state";
import { Button } from "../../src/shared/design-system/ui/Button";
import "../../src/shared/styles/globals.css";

const viewer = keypair().pubkey;
const peer = keypair().pubkey;
const owner = createRelaySession({
  viewer,
  relayAuthor: keypair().pubkey,
  media: () => undefined,
  query: async () => [],
});
const channelId = "boundary-restoration";
const scope = "boundary-restoration-fixture";
const boundaryId = "row-100";
const rows: ChannelMessage[] = Array.from({ length: 180 }, (_, index) => ({
  id: `row-${index}`,
  channelId,
  authorId: peer,
  createdAt: 1792152000 + index,
  content: `Message ${index}. Keep this reading position through a timeline remount.`,
  mentions: [],
  attachments: [],
  reactions: [],
  replyCount: 0,
  participants: [],
}));
const windowSnapshot: ChannelWindow = {
  channelId,
  rows,
  status: "ready",
  freshness: "verified",
  hasMore: false,
  loadingOlder: false,
  error: undefined,
};
const list = {
  status: "ready" as const,
  channels: [{ id: channelId, name: "Restoration", members: [viewer] }],
};
const unreadSnapshot = {
  target: { kind: "channel" as const, channelId },
  observedCount: 80,
  attentionCount: 0,
  coverage: "observed" as const,
  freshness: "observed" as const,
  manual: "none" as const,
};
const syncSnapshot = {
  ...owner.session.unread.sync(),
  completeness: "snapshot" as const,
};
const session = {
  ...owner.session,
  channels: {
    ...owner.session.channels,
    window: () => windowSnapshot,
    list: () => list,
    subscribeList: () => () => {},
  },
  unread: {
    ...owner.session.unread,
    enterChannel: async () => {},
    snapshot: () => unreadSnapshot,
    sync: () => syncSnapshot,
    attention: (_channel: string, id: string) => ({
      status: "eligible" as const,
      unread: Number(id.slice(4)) >= 100,
      forced: false,
      viewing: false,
    }),
  },
};
writeView(scope, `scroll:${channelId}`, {
  bottom: false,
  offset: 5000,
  anchor: { id: boundaryId, y: 20 },
});
Object.assign(window, {
  boundaryRestoration: {
    boundaryId,
    saved: () => readView(scope, `scroll:${channelId}`, null),
  },
});

function Fixture() {
  const [visible, setVisible] = useState(true);
  return (
    <main
      style={{ height: "100dvh", display: "flex", flexDirection: "column" }}
    >
      <Button onClick={() => setVisible(!visible)}>
        {visible ? "Hide timeline" : "Restore timeline"}
      </Button>
      <MessageManagement session={session} channelId={channelId}>
        {visible && (
          <ChannelTimeline
            scope={scope}
            channelId={channelId}
            viewer={viewer}
            queries={session}
            window={windowSnapshot}
            marksRead={false}
            onOpenLink={() => false}
          />
        )}
      </MessageManagement>
    </main>
  );
}
const root = document.getElementById("root");
if (!root) throw new Error("Missing fixture root");
createRoot(root).render(
  <StrictMode>
    <Fixture />
  </StrictMode>,
);
