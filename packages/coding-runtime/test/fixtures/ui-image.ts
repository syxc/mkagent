/** Exercise renderer images in a fresh process, including relocated bundles. */
import assert from 'node:assert/strict';
import { ToolExecutionComponent as SDKToolExecutionComponent, initTheme } from '@earendil-works/pi-coding-agent';
import { setCapabilities, setCellDimensions, setImageTranscoder, type TUI } from '@earendil-works/pi-tui';
import { ToolExecutionComponent } from '../../src/native-ui.ts';

initTheme(undefined, false);
setCapabilities({ images: 'kitty', trueColor: true, hyperlinks: false });
setCellDimensions({ widthPx: 8, heightPx: 16 });
setImageTranscoder(undefined);
let renders = 0;
const ready = Promise.withResolvers<void>();
const Component = process.argv.includes('--sdk') ? SDKToolExecutionComponent : ToolExecutionComponent;
const tool = new Component('image-fixture', 'image-call', {}, undefined, undefined, {
  requestRender() { renders++; ready.resolve(); },
} as TUI, process.cwd());
const gif = 'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
tool.updateResult({ content: [{ type: 'image', mimeType: 'image/gif', data: gif }], isError: false });
let timeout: ReturnType<typeof setTimeout>;
try {
  await Promise.race([ready.promise, new Promise<never>((_, reject) => {
    timeout = setTimeout(() => reject(new Error('PNG transcoder did not request a render')), 4_000);
  })]);
} finally {
  clearTimeout(timeout!);
}
const first = tool.render(60).join('\n');
assert(first.includes('\x1b_G'), 'non-PNG image did not use the Kitty image protocol');
assert(first.includes('iVBORw0KGgo'), 'Kitty payload is not PNG');
assert(renders > 0, 'transcoder registration did not invalidate the renderer');
const id = first.match(/,i=(\d+)/)?.[1];
assert(id, 'missing image ID');
tool.invalidate();
assert.equal(tool.render(60).join('\n').match(/,i=(\d+)/)?.[1], id, 'image cache changed on invalidation');
tool.setShowImages(false);
assert(!tool.render(60).join('\n').includes('\x1b_G'), 'image visibility was ignored');
tool.setShowImages(true);
assert(tool.render(60).join('\n').includes('\x1b_G'), 'image was not restored');
tool.setImageWidthCells(17);
assert(tool.render(60).join('\n').includes('iVBORw0KGgo'), 'image width update lost conversion');
console.log(JSON.stringify({ mode: process.argv.includes('--sdk') ? 'sdk' : 'native', png: true, cache: true, visibility: true }));
