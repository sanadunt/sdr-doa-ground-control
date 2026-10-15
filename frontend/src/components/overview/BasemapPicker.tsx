import type { CSSProperties, FocusEvent as ReactFocusEvent, JSX, MouseEvent as ReactMouseEvent } from 'react';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { BASEMAPS, BASEMAP_ORDER, normalizeBasemapId } from '../../lib/basemaps';
import type { BasemapId } from '../../lib/basemaps';
import { useI18n } from '../../lib/i18n';
import { Icon } from '../ui';

const MENU_ID = 'ov-basemap-menu';
const GAP_PX = 6;
const EDGE_PX = 8;
const MAX_MENU_HEIGHT_PX = 420;

type PopoverElement = HTMLDivElement & { showPopover?: () => void; hidePopover?: () => void };

/**
 * Where the open menu goes: above the button when it fits there (the map
 * controls sit at the bottom of the map), otherwise on the side with more
 * room, kept inside the viewport.
 */
export function basemapMenuPosition(
  button: { top: number; bottom: number; left: number },
  menu: { width: number; height: number },
  viewport: { width: number; height: number },
): CSSProperties {
  const above = button.top - GAP_PX - EDGE_PX;
  const below = viewport.height - button.bottom - GAP_PX - EDGE_PX;
  const up = above >= Math.min(menu.height, 240) || above >= below;
  const maxHeight = Math.max(88, Math.min(MAX_MENU_HEIGHT_PX, up ? above : below));
  const left = Math.max(EDGE_PX, Math.min(button.left, viewport.width - menu.width - EDGE_PX));
  return up
    ? { left, bottom: viewport.height - button.top + GAP_PX, top: 'auto', maxHeight }
    : { left, top: button.bottom + GAP_PX, bottom: 'auto', maxHeight };
}

/**
 * Map-controls button with a radio menu of the basemap styles. The menu is a
 * popover in the browser's top layer, so the floating Dashboard panels and
 * the dock (siblings of the map's stacking context) never cover it. Picking a
 * style applies it at once and keeps the menu open, so the arrow keys step
 * through the styles; Escape, a click outside, Tab out or the button closes it.
 */
export function BasemapMenu({ value, onChange }: { value: BasemapId; onChange: (id: BasemapId) => void }): JSX.Element {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<CSSProperties>({});
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<PopoverElement>(null);

  const close = useCallback((returnFocus: boolean) => {
    // The button stays visible, so focus moves there before the menu hides.
    if (returnFocus) buttonRef.current?.focus();
    setOpen(false);
  }, []);

  const place = useCallback(() => {
    const button = buttonRef.current;
    const menu = menuRef.current;
    if (!button || !menu) return;
    const rect = button.getBoundingClientRect();
    setPosition(basemapMenuPosition(rect, { width: menu.offsetWidth, height: menu.scrollHeight }, { width: window.innerWidth, height: window.innerHeight }));
  }, []);

  // Show in the top layer, place it, and move focus to the chosen style.
  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (!menu || !open) return undefined;
    try {
      menu.showPopover?.();
    } catch {
      // Already showing, or no popover support: the fixed menu still opens.
    }
    place();
    menu.querySelector<HTMLInputElement>('input:checked')?.focus();
    return () => {
      try {
        menu.hidePopover?.();
      } catch {
        // Already hidden.
      }
    };
  }, [open, place]);

  useEffect(() => {
    if (!open) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        close(true);
      }
    };
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (menuRef.current?.contains(target) || buttonRef.current?.contains(target)) return;
      close(false);
    };
    let frame = 0;
    const onMove = () => {
      if (!frame) frame = window.requestAnimationFrame(() => { frame = 0; place(); });
    };
    window.addEventListener('keydown', onKeyDown);
    document.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('resize', onMove);
    window.addEventListener('scroll', onMove, true);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('resize', onMove);
      window.removeEventListener('scroll', onMove, true);
    };
  }, [open, close, place]);

  // Tabbing out of the open menu closes it and leaves focus where it went.
  // Focus that falls back to a container around the menu (main has
  // tabindex=-1) comes from a click inside it and does not count.
  const onBlur = (event: ReactFocusEvent<HTMLDivElement>) => {
    const next = event.relatedTarget;
    const menu = event.currentTarget;
    if (next instanceof Node && !menu.contains(next) && !next.contains(menu) && next !== buttonRef.current) setOpen(false);
  };
  // A press on an option's text keeps focus in the group; the chosen radio then takes it.
  const onMouseDown = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (!(event.target instanceof HTMLInputElement)) event.preventDefault();
  };

  const label = t('map.basemap');
  return (
    <div className="ov-basemap">
      <button
        ref={buttonRef}
        className="ov-map-button"
        type="button"
        aria-haspopup="true"
        aria-expanded={open}
        aria-controls={MENU_ID}
        aria-label={label}
        title={label}
        onClick={() => (open ? close(false) : setOpen(true))}
      >
        <Icon name="map" />
      </button>
      <div
        ref={menuRef}
        id={MENU_ID}
        className="ov-basemap-menu"
        popover="manual"
        role="radiogroup"
        aria-label={label}
        hidden={!open}
        style={position}
        onBlur={onBlur}
        onMouseDown={onMouseDown}
      >
        {BASEMAP_ORDER.map((id) => (
          <label key={id} className="ov-basemap-option">
            <input
              type="radio"
              name={MENU_ID}
              value={id}
              checked={value === id}
              onChange={(event) => {
                event.currentTarget.focus();
                onChange(id);
              }}
            />
            <span>{t(BASEMAPS[id].labelKey)}</span>
          </label>
        ))}
      </div>
    </div>
  );
}

/** The same choice as a select, first row of the Lapisan panel. */
export function BasemapSelect({ value, onChange }: { value: BasemapId; onChange: (id: BasemapId) => void }): JSX.Element {
  const { t } = useI18n();
  return (
    <label className="ov-basemap-row">
      <span>{t('map.basemap')}</span>
      <select value={value} onChange={(event) => onChange(normalizeBasemapId(event.target.value))}>
        {BASEMAP_ORDER.map((id) => <option key={id} value={id}>{t(BASEMAPS[id].labelKey)}</option>)}
      </select>
    </label>
  );
}
