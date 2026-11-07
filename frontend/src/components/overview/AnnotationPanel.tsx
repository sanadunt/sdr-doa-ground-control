import { useEffect, useRef, useState, type CSSProperties, type JSX } from 'react';
import { useI18n } from '../../lib/i18n';
import type { MessageKey } from '../../lib/i18n';
import {
  ANNOTATION_CATEGORIES,
  CATEGORY_COLORS,
  MAP_ANNOTATION_COLORS,
  MAP_ANNOTATION_LIMITS,
  annotationCentre,
  annotationErrorKey,
  formatArea,
  formatLength,
  lastLegBearing,
  pathLengthM,
  polygonAreaM2,
  polygonPerimeterM,
  writeAnnotation,
  type AnnotationCategory,
  type AnnotationColor,
  type AnnotationDraft,
  type AnnotationTool,
  type AnnotationWrite,
  type AnnotationWriteResult,
  type LonLat,
  type MapAnnotation,
} from '../../lib/mapAnnotations';
import { Icon } from '../ui';

interface FormState {
  /** The mark being changed, or null for a new one. */
  id: string | null;
  rev: number;
  kind: 'point' | 'area';
  geometry: LonLat | LonLat[];
  name: string;
  category: AnnotationCategory;
  color: AnnotationColor;
  note: string;
}

type Message = { tone: 'good' | 'bad'; key: MessageKey } | null;

const COLOR_NAMES: Record<AnnotationColor, string> = {
  '#f08a24': 'orange', '#e5484d': 'red', '#30a46c': 'green', '#3e8ed0': 'blue',
  '#a78bfa': 'violet', '#f5d90a': 'yellow', '#14b8a6': 'teal', '#ffffff': 'white',
};

function newForm(kind: 'point' | 'area', geometry: LonLat | LonLat[]): FormState {
  return { id: null, rev: 0, kind, geometry, name: '', category: kind === 'area' ? 'nogo' : 'suspect', color: CATEGORY_COLORS[kind === 'area' ? 'nogo' : 'suspect'], note: '' };
}

function formOf(item: MapAnnotation): FormState {
  return { id: item.id, rev: item.rev, kind: item.kind, geometry: item.geometry, name: item.name, category: item.category, color: item.color, note: item.note };
}

/**
 * The map marks panel (lib/mapAnnotations.ts): the hint and result of the
 * tool in use (measure, draw an area, place a marker), the form that saves a
 * drawn mark for every page, the picked mark with Edit and Delete, and the
 * list of every mark. A save or a delete goes to the console at once; a
 * change another page made in between comes back as a conflict.
 */
export function AnnotationPanel({ tool, draft, items, stale, selected, onTool, onDraftChange, onSelect, onFocus, onChanged, write = writeAnnotation }: {
  tool: AnnotationTool;
  draft: readonly LonLat[];
  items: readonly MapAnnotation[];
  stale: boolean;
  selected: MapAnnotation | null;
  onTool: (tool: AnnotationTool) => void;
  onDraftChange: (draft: LonLat[]) => void;
  onSelect: (id: string | null) => void;
  onFocus: (center: LonLat) => void;
  /** Read the marks again after a change. */
  onChanged: () => void;
  write?: (write: AnnotationWrite) => Promise<AnnotationWriteResult>;
}): JSX.Element {
  const { t, lang } = useI18n();
  const [form, setForm] = useState<FormState | null>(null);
  const [message, setMessage] = useState<Message>(null);
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const cancelDeleteRef = useRef<HTMLButtonElement>(null);
  // A marker opens its form with the first tap on the map; another tap moves it.
  useEffect(() => {
    if (tool === 'point' && draft.length === 1) setForm((current) => (current && current.id === null ? { ...current, geometry: draft[0] } : newForm('point', draft[0])));
  }, [tool, draft]);
  useEffect(() => { if (confirmDelete) cancelDeleteRef.current?.focus(); }, [confirmDelete]);
  // Another pick drops a half-done edit or delete.
  useEffect(() => { setConfirmDelete(false); }, [selected?.id]);

  const stopDrawing = () => {
    onDraftChange([]);
    onTool('none');
  };
  const run = async (request: AnnotationWrite, done: (result: Extract<AnnotationWriteResult, { ok: true }>) => void) => {
    setBusy(true);
    setMessage(null);
    const result = await write(request);
    setBusy(false);
    onChanged();
    if (result.ok) {
      done(result);
      return;
    }
    setMessage({ tone: 'bad', key: annotationErrorKey(result.code) });
    // A conflict shows the other page's version in the form, to check and save again.
    if (result.code === 'ANNOTATION_CONFLICT' && result.current && form) setForm({ ...formOf(result.current) });
    if (result.code === 'ANNOTATION_NOT_FOUND') { setForm(null); onSelect(null); }
  };
  const save = () => {
    if (!form) return;
    if (!form.name.trim()) { setMessage({ tone: 'bad', key: 'annot.nameRequired' }); return; }
    const item: AnnotationDraft = { kind: form.kind, category: form.category, color: form.color, name: form.name, note: form.note, geometry: form.geometry };
    const request: AnnotationWrite = form.id === null ? { op: 'create', item } : { op: 'update', id: form.id, rev: form.rev, item };
    void run(request, (result) => {
      setForm(null);
      setMessage({ tone: 'good', key: 'annot.saved' });
      if (form.id === null) stopDrawing();
      if (result.item) onSelect(result.item.id);
    });
  };
  const remove = () => {
    if (!selected) return;
    void run({ op: 'delete', id: selected.id, rev: selected.rev }, () => {
      setConfirmDelete(false);
      setMessage({ tone: 'good', key: 'annot.deleted' });
      onSelect(null);
    });
  };
  const close = () => {
    setForm(null);
    setConfirmDelete(false);
    setMessage(null);
    onSelect(null);
    stopDrawing();
  };

  const status = message ? <p className={message.tone === 'bad' ? 'ov-annot-status is-bad' : 'ov-annot-status'} role="status">{t(message.key)}</p> : null;
  const head = (
    <div className="ov-card-head ov-card-head-rule">
      <h2>{t('annot.title')}</h2>
      <button className="ov-icon-button" type="button" aria-label={t('annot.close')} title={t('annot.close')} onClick={close}><Icon name="close" /></button>
    </div>
  );

  let body: JSX.Element;
  if (form) {
    const corners = form.kind === 'area' ? form.geometry as LonLat[] : null;
    body = (
      <form className="ov-annot-form" onSubmit={(event) => { event.preventDefault(); save(); }}>
        <p className="ov-annot-meta">{t(form.kind === 'area' ? 'annot.kind.area' : 'annot.kind.point')}{corners ? ` · ${t('annot.areaSize', { area: formatArea(polygonAreaM2(corners)), perimeter: formatLength(polygonPerimeterM(corners)) })}` : ''}</p>
        <label className="ov-annot-field">
          <span>{t('annot.name')}</span>
          <input value={form.name} maxLength={MAP_ANNOTATION_LIMITS.nameMax} autoFocus onChange={(event) => setForm({ ...form, name: event.target.value })} />
        </label>
        <label className="ov-annot-field">
          <span>{t('annot.category')}</span>
          <select value={form.category} onChange={(event) => { const category = event.target.value as AnnotationCategory; setForm({ ...form, category, color: CATEGORY_COLORS[category] }); }}>
            {ANNOTATION_CATEGORIES.map((category) => <option key={category} value={category}>{t(`annot.cat.${category}`)}</option>)}
          </select>
        </label>
        <fieldset className="ov-annot-colors">
          <legend>{t('annot.color')}</legend>
          {MAP_ANNOTATION_COLORS.map((color) => (
            <label key={color} className="ov-annot-swatch" style={{ '--swatch': color } as CSSProperties} title={t('annot.colorOption', { color: COLOR_NAMES[color] })}>
              <input type="radio" name="annot-color" value={color} checked={form.color === color} aria-label={t('annot.colorOption', { color: COLOR_NAMES[color] })} onChange={() => setForm({ ...form, color })} />
            </label>
          ))}
        </fieldset>
        <label className="ov-annot-field">
          <span>{t('annot.note')}</span>
          <textarea value={form.note} maxLength={MAP_ANNOTATION_LIMITS.noteMax} rows={3} onChange={(event) => setForm({ ...form, note: event.target.value })} />
        </label>
        <div className="ov-annot-actions">
          <button className="ov-button is-primary" type="submit" disabled={busy}>{busy ? t('annot.saving') : t('annot.save')}</button>
          <button className="ov-button" type="button" disabled={busy} onClick={() => { setForm(null); setMessage(null); if (form.id === null) stopDrawing(); }}>{t('annot.cancel')}</button>
        </div>
      </form>
    );
  } else if (tool === 'measure') {
    const bearing = lastLegBearing(draft);
    body = (
      <div className="ov-annot-tool">
        <p className="ov-annot-hint">{t('annot.hintMeasure')}</p>
        {draft.length >= 2 ? (
          <>
            <p className="ov-annot-result">{t('annot.total', { distance: formatLength(pathLengthM(draft)) })}</p>
            <p className="ov-annot-meta">{t('annot.legs', { count: String(draft.length - 1), bearing: bearing === null ? '--' : bearing.toFixed(0) })}</p>
          </>
        ) : null}
        <div className="ov-annot-actions">
          <button className="ov-button" type="button" disabled={draft.length === 0} onClick={() => onDraftChange(draft.slice(0, -1))}>{t('annot.undo')}</button>
          <button className="ov-button" type="button" disabled={draft.length === 0} onClick={() => onDraftChange([])}>{t('annot.clear')}</button>
        </div>
      </div>
    );
  } else if (tool === 'area' || tool === 'point') {
    body = (
      <div className="ov-annot-tool">
        <p className="ov-annot-hint">{t(tool === 'area' ? 'annot.hintArea' : 'annot.hintPoint')}</p>
        {tool === 'area' && draft.length >= 3 ? <p className="ov-annot-result">{t('annot.areaSize', { area: formatArea(polygonAreaM2(draft)), perimeter: formatLength(polygonPerimeterM(draft)) })}</p> : null}
        <div className="ov-annot-actions">
          {tool === 'area' ? (
            <>
              <button className="ov-button is-primary" type="button" disabled={draft.length < MAP_ANNOTATION_LIMITS.areaMinVertices} onClick={() => setForm(newForm('area', [...draft]))}>{t('annot.finish')}</button>
              <button className="ov-button" type="button" disabled={draft.length === 0} onClick={() => onDraftChange(draft.slice(0, -1))}>{t('annot.undo')}</button>
            </>
          ) : null}
          <button className="ov-button" type="button" onClick={stopDrawing}>{t('annot.cancel')}</button>
        </div>
      </div>
    );
  } else if (selected) {
    const corners = selected.kind === 'area' ? selected.geometry as LonLat[] : null;
    const point = selected.kind === 'point' ? selected.geometry as LonLat : null;
    const time = new Date(selected.updatedMs).toLocaleString(lang === 'id' ? 'id-ID' : 'en-GB', { dateStyle: 'short', timeStyle: 'short' });
    body = (
      <div className="ov-annot-detail">
        <p className="ov-annot-name"><span className="ov-annot-dot" style={{ background: selected.color }} aria-hidden="true" />{selected.name}</p>
        <p className="ov-annot-meta">{t(`annot.kind.${selected.kind}`)} · {t(`annot.cat.${selected.category}`)}</p>
        {corners ? <p className="ov-annot-result">{t('annot.areaSize', { area: formatArea(polygonAreaM2(corners)), perimeter: formatLength(polygonPerimeterM(corners)) })}</p> : null}
        {point ? <p className="ov-annot-result">{point[1].toFixed(5)}, {point[0].toFixed(5)}</p> : null}
        {selected.note ? <p className="ov-annot-note">{selected.note}</p> : null}
        <p className="ov-annot-meta">{t('annot.by', { by: selected.by, time })}</p>
        {confirmDelete ? (
          <div className="ov-annot-confirm" role="alertdialog" aria-label={t('annot.deleteConfirm', { name: selected.name })} onKeyDown={(event) => { if (event.key === 'Escape') setConfirmDelete(false); }}>
            <p>{t('annot.deleteConfirm', { name: selected.name })}</p>
            <div className="ov-annot-actions">
              <button ref={cancelDeleteRef} className="ov-button" type="button" onClick={() => setConfirmDelete(false)}>{t('annot.cancel')}</button>
              <button className="ov-button is-danger" type="button" disabled={busy} onClick={remove}>{t('annot.deleteYes')}</button>
            </div>
          </div>
        ) : (
          <div className="ov-annot-actions">
            <button className="ov-button" type="button" onClick={() => { setMessage(null); setForm(formOf(selected)); }}>{t('annot.edit')}</button>
            <button className="ov-button" type="button" onClick={() => setConfirmDelete(true)}>{t('annot.delete')}</button>
            <button className="ov-button" type="button" aria-label={t('annot.focus')} title={t('annot.focus')} onClick={() => onFocus(annotationCentre(selected))}><Icon name="crosshair" /></button>
            {tool === 'list' ? <button className="ov-button" type="button" aria-label={t('annot.toolList')} title={t('annot.toolList')} onClick={() => onSelect(null)}><Icon name="list" /></button> : null}
          </div>
        )}
      </div>
    );
  } else {
    body = (
      <div className="ov-annot-list">
        <p className="ov-annot-meta">{t('annot.count', { count: String(items.length) })}</p>
        {items.length === 0 ? <p className="ov-annot-hint">{t('annot.empty')}</p> : (
          <ul>
            {items.map((item) => (
              <li key={item.id}>
                <button type="button" className="ov-annot-row" onClick={() => { onSelect(item.id); onFocus(annotationCentre(item)); }}>
                  <span className="ov-annot-dot" style={{ background: item.color }} aria-hidden="true" />
                  <span className="ov-annot-row-name">{item.name}</span>
                  <span className="ov-annot-row-cat">{t(`annot.cat.${item.category}`)}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    );
  }
  return (
    <section className="ov-card ov-annotations" aria-label={t('annot.title')}>
      {head}
      <div className="ov-annot-body">
        {stale ? <p className="ov-annot-status is-bad">{t('annot.stale')}</p> : null}
        {body}
        {status}
      </div>
    </section>
  );
}
