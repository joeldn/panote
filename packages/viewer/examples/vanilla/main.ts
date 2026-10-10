// An app imports from '@panote/viewer'; the example uses the source so it
// runs without a build.
import { PanoViewer, urlTemplateSource } from '../../src/index.js';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

// The test cube make-cube.ts writes into public/: 256 px tiles, levels
// 0 and 1, laid out as cube/<level>/<face>/<x>-<y>.png.
const source = urlTemplateSource({
  id: 'test-cube',
  template: 'cube/{level}/{face}/{x}-{y}.png',
  tileSize: 256,
  maxLevel: 1,
});

const viewer = new PanoViewer($('viewer'), {
  interaction: { label: 'Synthetic test cube' },
});

const status = $('status');
viewer.on('ready', (s) => (status.textContent = `${s.id}: base loaded`));
viewer.on('tiles-settled', () => (status.textContent = 'every visible tile is in'));
viewer.load(source).catch((err: unknown) => (status.textContent = `failed: ${String(err)}`));

const view = $('view');
viewer.onRender((v) => {
  view.textContent = `yaw ${v.yaw.toFixed(2)} rad, pitch ${v.pitch.toFixed(2)} rad, fov ${v.fov.toFixed(0)}°`;
});

$<HTMLInputElement>('rotate').addEventListener('change', (e) => {
  viewer.setAutoRotate((e.target as HTMLInputElement).checked);
});
$('ahead').addEventListener('click', () => viewer.setView({ yaw: 0, pitch: 0, fov: 70 }));
