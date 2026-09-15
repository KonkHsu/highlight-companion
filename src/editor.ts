import { StateField, EditorState } from '@codemirror/state';
import { Decoration, DecorationSet, EditorView } from '@codemirror/view';
import { editorLivePreviewField } from 'obsidian';

function decorations(state: EditorState): DecorationSet {
  if (!state.field(editorLivePreviewField, false)) return Decoration.none;
  const source = state.doc.toString();
  // Source mode remains a transparent view of the underlying Markdown.
  const ranges = [...source.matchAll(/<!--hc(?:[:\-])[^\n]*?-->/g)].map(m => Decoration.replace({}).range(m.index!, m.index! + m[0].length));
  return Decoration.set(ranges, true);
}
export const hideInternalMarkers = StateField.define<DecorationSet>({
  create: decorations,
  update(value, transaction) {
    return transaction.docChanged || transaction.state.field(editorLivePreviewField, false) !== transaction.startState.field(editorLivePreviewField, false)
      ? decorations(transaction.state) : value;
  },
  provide: field => EditorView.decorations.from(field)
});
