import { Face } from './face';
import { Transport } from './transport';
import { STATES, type StateName } from './expressions';
import './style.css';

const params = new URLSearchParams(location.search);
const DEV = params.has('dev');
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

// The face is a pure view. It owns no policy — the orchestrator decides that a
// fault outranks a mood, that sleep follows idle, and so on. All this does is
// draw what it is told, and keep drawing when told nothing.

if (DEV) {
  const panel = document.createElement('div');
  panel.id = 'dev';
  for (const name of Object.keys(STATES) as StateName[]) {
    const b = document.createElement('button');
    b.textContent = name;
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

  // Drag anywhere on the face to simulate gaze from the tracker.
  let dragging = false;
  const setLook = (e: PointerEvent) => {
    const r = canvas.getBoundingClientRect();
    face.setLook(
      ((e.clientX - r.left) / r.width - 0.5) * 2,
      ((e.clientY - r.top) / r.height - 0.5) * 2,
    );
  };
  canvas.addEventListener('pointerdown', (e) => { dragging = true; setLook(e); });
  canvas.addEventListener('pointermove', (e) => { if (dragging) setLook(e); });
  addEventListener('pointerup', () => { dragging = false; face.setLook(0, 0); });

  document.body.appendChild(panel);
}
