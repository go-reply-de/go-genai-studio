import { visit } from 'unist-util-visit';
import type { Pluggable } from 'unified';

/** Agents sometimes write the anchor `turn0search0` as `[turn0search0, turn0search1]`, or a group
 * as `\ue200entity|turn0search0<TAB>turn0search1\ue201`; read both as the anchors they stand for,
 * so the chips still appear. */
const BRACKET_ANCHORS = /\[(turn\d+search\d+(?:\s*,\s*turn\d+search\d+)*)\]/g;
const ENTITY_ANCHORS =
  /(?:\ue200|\\ue200)entity\|(turn\d+search\d+(?:\s+turn\d+search\d+)*)(?:\ue201|\\ue201)/g;

const anchorsFor = (list: string) => {
  const ids: string[] = list.match(/turn\d+search\d+/g) ?? [];
  const anchors = ids.map((id) => `\\ue202${id}`).join('');
  return ids.length > 1 ? `\\ue200${anchors}\\ue201` : anchors;
};

export const asAnchors = (text: string) =>
  text
    .replace(BRACKET_ANCHORS, (_, list: string) => anchorsFor(list))
    .replace(ENTITY_ANCHORS, (_, list: string) => anchorsFor(list));

export const groundingAnchorsPlugin: Pluggable = () => (tree) => {
  visit(tree, 'text', (node: { value: string }) => {
    node.value = asAnchors(node.value);
  });
};
