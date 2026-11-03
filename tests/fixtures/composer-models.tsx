// The real composer control and React lifecycle, with a read-only model catalog.
// No native harness, relay, credentials or live agent execution.
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { ComposerModels } from "../../src/features/messages/ComposerModels";
import { AgentsContext } from "../../src/features/agents/react";
import type { Agents } from "../../src/features/agents/service";
import type { MentionPicks } from "../../src/features/relay/messages";
import type { ProfileQueries } from "../../src/features/relay/profile-directory";
import { createAppearance } from "../../src/shared/theme/service";
import { useKeyboardFocusVisibility } from "../../src/shared/design-system/useKeyboardFocusVisibility";
import "../../src/shared/styles/globals.css";

createAppearance();
const pubkey = "a".repeat(64);
const snapshot = {
  status: "ready",
  agents: [{ pubkey, name: "Honey", type: "test/agent" }],
};
const types = [
  {
    key: "test/agent",
    models: () => ({
      current: "fixture",
      models: [
        {
          id: "fixture",
          label: "Fixture model",
          effort: "medium",
          efforts: [
            { id: "low", label: "Low" },
            { id: "medium", label: "Medium" },
            { id: "high", label: "High" },
          ],
        },
        {
          id: "alternate",
          label: "Alternate model",
          effort: "medium",
          efforts: [
            { id: "low", label: "Low" },
            { id: "medium", label: "Medium" },
            { id: "high", label: "High" },
          ],
        },
      ],
    }),
  },
];
// The catalog is immutable; these are the only service reads the control uses.
const agents = {
  find: (key: string) => snapshot.agents.find((agent) => agent.pubkey === key),
  subscribe: () => () => {},
  snapshot: () => snapshot,
  types: () => types,
} as unknown as Agents;
// No profile picture: the handle shows initials and the fill stays the theme accent.
const profiles: ProfileQueries = {
  snapshot: () => new Map(),
  subscribe: () => () => {},
  ensure: async () => {},
};
const media = () => undefined;
const ignoreResolved = () => {};
function Fixture() {
  useKeyboardFocusVisibility();
  const [picks, setPicks] = useState<MentionPicks>({});
  return (
    <AgentsContext.Provider value={agents}>
      <main className="mx-auto flex max-w-2xl flex-col gap-4 p-8">
        <h1 className="text-title">Composer model and effort</h1>
        <button type="button">Outside the picker</button>
        <form aria-label="Composer controls">
          <ComposerModels
            pubkeys={[pubkey]}
            profiles={profiles}
            media={media}
            value={picks}
            disabled={false}
            resettable
            explicitOnly
            startsThread={false}
            place={{ channelId: "fixture" }}
            onChange={setPicks}
            onResolved={ignoreResolved}
          />
        </form>
      </main>
    </AgentsContext.Provider>
  );
}
const container = document.getElementById("root");
if (!container) throw new Error("Missing fixture root");
createRoot(container).render(<Fixture />);
