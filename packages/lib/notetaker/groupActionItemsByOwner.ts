export type NotetakerActionItemGroup = { owner: string | null; items: string[] };

export function groupActionItemsByOwner(
  items: readonly { text: string; owner: string | null }[]
): NotetakerActionItemGroup[] {
  const named = new Map<string, NotetakerActionItemGroup>();
  const unassigned: NotetakerActionItemGroup = { owner: null, items: [] };

  for (const item of items) {
    const owner = item.owner?.trim() ?? "";
    if (owner === "") {
      unassigned.items.push(item.text);
      continue;
    }
    // Speakers are spelled inconsistently across the model output ("ada" vs "Ada"), so the key ignores case
    const key = owner.toLocaleLowerCase();
    const group = named.get(key);
    if (group) {
      group.items.push(item.text);
    } else {
      named.set(key, { owner, items: [item.text] });
    }
  }

  const groups = Array.from(named.values());
  if (unassigned.items.length > 0) groups.push(unassigned);
  return groups;
}
