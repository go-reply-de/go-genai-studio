import { visit } from 'unist-util-visit';
import type { Pluggable } from 'unified';

/** Agents sometimes write the anchor `turn0search0` as `[turn0search0, turn0search1]`;
 * read that as the anchors it stands for, so the chips still appear. */
const BRACKET_ANCHORS = /\[(turn\d+search\d+(?:\s*,\s*turn\d+search\d+)*)\]/g;

export const asAnchors = (text: string) =>
  text.replace(BRACKET_ANCHORS, (_, list: string) => {
    const ids = list.split(/\s*,\s*/);
    const anchors = ids.map((id) => `\\ue202${id}`).join('');
    return ids.length > 1 ? `\\ue200${anchors}\\ue201` : anchors;
  });

export const groundingAnchorsPlugin: Pluggable = () => (tree) => {
  visit(tree, 'text', (node: { value: string }) => {
    node.value = asAnchors(node.value);
  });
};
