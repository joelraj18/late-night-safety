// Session chart: eye openness over the drive, with sleep alarms, drowsy
// warnings and yawns marked. Plain <canvas>, no libraries (works offline).
// Colours come from CSS custom properties on the container (see app.css).

import { EVENT_LABELS, formatClock } from './session-log.js';

const PLOT_H = 180;
const AXIS_H = 26;
const PAD = { left: 40, right: 12, top: 14 };
const TIME_STEPS = [10, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200];

function cssVar(el, name, fallback) {
  return getComputedStyle(el).getPropertyValue(name).trim() || fallback;
}

export class SessionChart {
  constructor(container) {
    this.container = container;
    container.replaceChildren();
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'chart-canvas';
    this.canvas.tabIndex = 0;
    this.canvas.setAttribute('role', 'img');
    this.tooltip = document.createElement('div');
    this.tooltip.className = 'chart-tooltip';
    this.tooltip.hidden = true;
    container.append(this.canvas, this.tooltip);
    this.hoverIndex = null;
    this.points = [];
    this.events = [];

    const move = (e) => {
      const rect = this.canvas.getBoundingClientRect();
      this.hoverAt(e.clientX - rect.left);
    };
    this.canvas.addEventListener('pointermove', move);
    this.canvas.addEventListener('pointerdown', move);
    this.canvas.addEventListener('pointerleave', () => this.hoverAt(null));
    this.canvas.addEventListener('blur', () => this.hoverAt(null));
    this.canvas.addEventListener('keydown', (e) => {
      if (!this.points.length) return;
      const step = e.shiftKey ? 10 : 1;
      if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
        e.preventDefault();
        const i = this.hoverIndex ?? (e.key === 'ArrowRight' ? -1 : this.points.length);
        const next = Math.min(this.points.length - 1, Math.max(0, i + (e.key === 'ArrowRight' ? step : -step)));
        this.hoverIndex = next;
        this.draw();
      }
    });
    this.resizeObserver = new ResizeObserver(() => this.draw());
    this.resizeObserver.observe(container);
  }

  setData(points, events, durationS) {
    this.points = points;
    this.events = events;
    this.durationS = Math.max(durationS, points.length ? points[points.length - 1].s + 1 : 0, 10);
    const alarms = events.filter((e) => e.type === 'alarm').length;
    this.canvas.setAttribute(
      'aria-label',
      `Eye openness over ${formatClock(this.durationS)}, with ${alarms} sleep alarm${alarms === 1 ? '' : 's'} marked. ` +
        'Use the arrow keys to read values; the table below lists every minute.',
    );
    this.hoverIndex = null;
    this.draw();
  }

  geometry() {
    const width = this.container.clientWidth || 320;
    const plotW = Math.max(50, width - PAD.left - PAD.right);
    const x = (s) => PAD.left + (s / this.durationS) * plotW;
    const y = (v) => PAD.top + (1 - v) * PLOT_H;
    return { width, height: PAD.top + PLOT_H + AXIS_H, plotW, x, y };
  }

  hoverAt(px) {
    if (px === null || !this.points.length) {
      this.hoverIndex = null;
    } else {
      const { plotW } = this.geometry();
      const s = ((px - PAD.left) / plotW) * this.durationS;
      let best = 0;
      let bestD = Infinity;
      for (let i = 0; i < this.points.length; i++) {
        const d = Math.abs(this.points[i].s - s);
        if (d < bestD) {
          bestD = d;
          best = i;
        }
      }
      this.hoverIndex = best;
    }
    this.draw();
  }

  draw() {
    const el = this.container;
    const c = {
      surface: cssVar(el, '--chart-surface', '#151922'),
      grid: cssVar(el, '--chart-grid', '#2a2f3a'),
      axis: cssVar(el, '--chart-axis', '#3a404c'),
      muted: cssVar(el, '--chart-muted', '#8f96a3'),
      line: cssVar(el, '--series-eye', '#3987e5'),
      yawn: cssVar(el, '--series-yawn', '#199e70'),
      alarm: cssVar(el, '--status-critical', '#d03b3b'),
      drowsy: cssVar(el, '--status-warning', '#fab219'),
    };
    const g = this.geometry();
    const dpr = window.devicePixelRatio || 1;
    const cv = this.canvas;
    cv.style.width = `${g.width}px`;
    cv.style.height = `${g.height}px`;
    cv.width = Math.round(g.width * dpr);
    cv.height = Math.round(g.height * dpr);
    const ctx = cv.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, g.width, g.height);
    ctx.font = '12px system-ui, -apple-system, "Segoe UI", sans-serif';

    // Gridlines + y ticks (0 / 50 / 100 %): solid hairlines, recessive.
    ctx.lineWidth = 1;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (const v of [0, 0.5, 1]) {
      const yy = Math.round(g.y(v)) + 0.5;
      ctx.strokeStyle = v === 0 ? c.axis : c.grid;
      ctx.beginPath();
      ctx.moveTo(PAD.left, yy);
      ctx.lineTo(PAD.left + g.plotW, yy);
      ctx.stroke();
      ctx.fillStyle = c.muted;
      ctx.fillText(`${Math.round(v * 100)}%`, PAD.left - 6, yy);
    }

    // X ticks: elapsed time, ~5 labels.
    const step = TIME_STEPS.find((st) => this.durationS / st <= 5) ?? 7200;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillStyle = c.muted;
    for (let s = 0; s <= this.durationS + 0.001; s += step) {
      const xx = g.x(s);
      if (xx > PAD.left + g.plotW - 14 && s !== 0) break;
      ctx.fillText(formatClock(s), xx, PAD.top + PLOT_H + 8);
    }

    // Eye openness: 10% wash under a 2px line, broken where the face was not visible.
    const runs = [];
    let run = [];
    for (const p of this.points) {
      if (p.eye === null) {
        if (run.length) runs.push(run);
        run = [];
      } else {
        run.push(p);
      }
    }
    if (run.length) runs.push(run);
    for (const r of runs) {
      ctx.beginPath();
      r.forEach((p, i) => (i ? ctx.lineTo(g.x(p.s + 0.5), g.y(p.eye)) : ctx.moveTo(g.x(p.s + 0.5), g.y(p.eye))));
      const last = r[r.length - 1];
      ctx.lineTo(g.x(last.s + 0.5), g.y(0));
      ctx.lineTo(g.x(r[0].s + 0.5), g.y(0));
      ctx.closePath();
      ctx.globalAlpha = 0.1;
      ctx.fillStyle = c.line;
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.beginPath();
      r.forEach((p, i) => (i ? ctx.lineTo(g.x(p.s + 0.5), g.y(p.eye)) : ctx.moveTo(g.x(p.s + 0.5), g.y(p.eye))));
      if (r.length === 1) ctx.lineTo(g.x(r[0].s + 1), g.y(r[0].eye));
      ctx.strokeStyle = c.line;
      ctx.lineWidth = 2;
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      ctx.stroke();
    }

    // Events. Alarms/drowsy: full-height rule + top dot. Yawns: dot on the baseline lane.
    const dot = (xx, yy, color) => {
      ctx.beginPath();
      ctx.arc(xx, yy, 6, 0, Math.PI * 2);
      ctx.fillStyle = c.surface;
      ctx.fill();
      ctx.beginPath();
      ctx.arc(xx, yy, 4, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
    };
    for (const e of this.events) {
      const xx = g.x(e.s);
      if (e.type === 'yawn') {
        dot(xx, g.y(0) - 8, c.yawn);
        continue;
      }
      const color = e.type === 'alarm' ? c.alarm : c.drowsy;
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(xx, g.y(1));
      ctx.lineTo(xx, g.y(0));
      ctx.stroke();
      dot(xx, g.y(1), color);
    }

    this.drawHover(ctx, g, c);
  }

  drawHover(ctx, g, c) {
    const p = this.hoverIndex === null ? null : this.points[this.hoverIndex];
    if (!p) {
      this.tooltip.hidden = true;
      return;
    }
    const xx = Math.round(g.x(p.s + 0.5)) + 0.5;
    ctx.strokeStyle = c.muted;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(xx, g.y(1));
    ctx.lineTo(xx, g.y(0));
    ctx.stroke();
    if (p.eye !== null) {
      ctx.beginPath();
      ctx.arc(xx, g.y(p.eye), 6, 0, Math.PI * 2);
      ctx.fillStyle = c.surface;
      ctx.fill();
      ctx.beginPath();
      ctx.arc(xx, g.y(p.eye), 4, 0, Math.PI * 2);
      ctx.fillStyle = c.line;
      ctx.fill();
    }

    const near = this.events.filter((e) => Math.abs(e.s - (p.s + 0.5)) <= Math.max(1, this.durationS / 200));
    const tip = this.tooltip;
    tip.replaceChildren();
    const value = document.createElement('div');
    value.className = 'chart-tooltip-value';
    value.textContent = p.eye === null ? 'Face not visible' : `${Math.round(p.eye * 100)}%`;
    const label = document.createElement('div');
    label.className = 'chart-tooltip-label';
    const key = document.createElement('span');
    key.className = 'line-key';
    label.append(key, document.createTextNode(`Eye openness · ${formatClock(p.s)}`));
    tip.append(value, label);
    for (const e of near) {
      const row = document.createElement('div');
      row.className = `chart-tooltip-event event-${e.type}`;
      row.textContent = EVENT_LABELS[e.type] ?? e.type;
      tip.append(row);
    }
    tip.hidden = false;
    const tw = tip.offsetWidth;
    const left = Math.min(Math.max(4, xx + 12), g.width - tw - 4);
    tip.style.transform = `translate(${xx + 12 + tw > g.width ? xx - tw - 12 : left}px, ${PAD.top}px)`;
  }

  destroy() {
    this.resizeObserver.disconnect();
    this.container.replaceChildren();
  }
}
