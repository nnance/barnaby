import { Face } from './face';
import { Transport } from './transport';
import { STATES, type StateName } from './expressions';
import './style.css';

const params = new URLSearchParams(location.search);
// Dev tools are ON by default under `npm run dev` and OFF in a production
// build. `?dev=1` forces them on (useful when previewing dist/), `?dev=0`
// forces them off (useful for checking what the kiosk will actually show).
const DEV = params.get('dev') === '0' ? false
  : params.get('dev') !== null ? true
  : import.meta.env.DEV;
const WS_URL = params.get('ws')
  ?? `ws://${location.hostname || '127.0.0.1'}:8711/face`;

const canvas = document.querySelector<HTMLCanvasElement>('#face');
if (!canvas) throw new Error('#face canvas missing');

const face = new Face(canvas);
face.start();

const transport = new Transport(WS_URL, {
  onState: (name) => face.setState(name),
  onLook: (x, y) => face.setLook(x, y),
  onOpen: () => document.body.classList.remove('disconnected'),
  onClose: () => document.body.classList.add('disconnected'),
});
transport.connect();

// Only the kiosk hides the cursor. On a laptop that just loses your pointer.
if (!DEV) document.body.classList.add('kiosk');

// The face is a pure view. It owns no policy — the orchestrator decides that a
// fault outranks a mood, that sleep follows idle, and so on. All this does is
// draw what it is told, and keep drawing when told nothing.

if (DEV) {
  const panel = document.createElement('div');
  panel.id = 'dev';
  for (const name of Object.keys(STATES) as StateName[]) {
    const b = document.createElement('button');
    b.dataset.state = name;
    b.textContent = `${Object.keys(STATES).indexOf(name) + 1}  ${name}`;
    b.onclick = () => {
      face.setState(name);
      for (const el of panel.querySelectorAll('button')) {
        el.classList.toggle('on', el === b);
      }
      const g = STATES[name].glow;
      swatch.style.background = g.hex;
      swatch.style.opacity = String(Math.min(1, g.level));
      label.textContent = `${g.hex} @ ${g.level.toFixed(2)}${g.pulse ? ' pulse' : ''}`;
    };
    panel.appendChild(b);
  }

  const row = document.createElement('div');
  row.className = 'glowrow';
  const swatch = document.createElement('span');
  swatch.className = 'swatch';
  const label = document.createElement('span');
  label.className = 'glowlabel';
  label.textContent = 'body glow';
  row.append(swatch, label);
  panel.appendChild(row);

  // Move the pointer anywhere in the window and Barnaby's eyes follow it —
  // this is what the face tracker will drive. No drag needed; the whole point
  // is that it should be immediately obvious that he's watching you.
  addEventListener('pointermove', (e) => {
    const r = canvas.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    face.setLook(
      (e.clientX - cx) / (r.width / 2),
      (e.clientY - cy) / (r.height / 2),
    );
  });
  addEventListener('pointerleave', () => face.setLook(0, 0));

  // Number keys cycle states without reaching for the mouse.
  const names = Object.keys(STATES) as StateName[];
  addEventListener('keydown', (e) => {
    const i = '1234567890'.indexOf(e.key);
    const name = i >= 0 ? names[i] : undefined;
    if (name) {
      const btn = panel.querySelector<HTMLButtonElement>(`[data-state="${name}"]`);
      btn?.click();
    }
  });

  document.body.appendChild(panel);
}
