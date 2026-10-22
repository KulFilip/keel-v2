// KeelBot's Slot action block(s), split out of Actions.tsx (Actions.tsx re-exports them).

import { CodeBlock, SLOTS, useSlot, type KeelbotBlock, type KeelbotCardItem } from "@keel/web-sdk";

/** A block no core card handles (```keel-query```, ```keel-git```: the Database and Git plugins' buttons): the card a
 *  plugin put in the slot keelbot.card for its kind ({ id, kind: "keel-query", component }), which gets { block, pid }.
 *  Live: the card shows once the plugin's web part has loaded. Without one (the plugin is not there) the block shows as
 *  the code it is. */
export function SlotCard({ pid, block }: { pid: string; block: KeelbotBlock }) {
  const card = useSlot<KeelbotCardItem>(SLOTS.keelbotCard).find((c) => c.kind === block.kind);
  if (!card) return <CodeBlock text={block.body} gutter={false} />;
  const Card = card.component;
  return <Card block={block} pid={pid} />;
}
