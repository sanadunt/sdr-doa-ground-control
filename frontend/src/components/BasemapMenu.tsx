import type { JSX } from 'react';
import { useEffect, useRef, useState } from 'react';
import { ONLINE_BASEMAPS, mbtilesBasemapId, type BasemapId, type TileSet } from '../lib/basemaps';
import { useI18n } from '../lib/i18n';
import { Icon } from './ui';

export function BasemapMenu({
  value,
  tileSets,
  onChange,
  onOpen,
}: {
  value: BasemapId;
  tileSets: readonly TileSet[];
  onChange: (id: BasemapId) => void;
  /** Called when the menu opens, so newly added MBTiles files show up. */
  onOpen: () => void;
}): JSX.Element {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return undefined;
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setOpen(false);
      buttonRef.current?.focus();
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const online = ONLINE_BASEMAPS.find((basemap) => basemap.id === value);
  const offline = tileSets.find((tileSet) => mbtilesBasemapId(tileSet.id) === value);
  const currentName = online ? t(online.labelKey) : offline ? offline.name : t('basemap.osm');
  const choose = (id: BasemapId) => {
    onChange(id);
    setOpen(false);
    buttonRef.current?.focus();
  };

  return (
    <div className="basemap-menu" ref={rootRef}>
      <button
        ref={buttonRef}
        type="button"
        className="toolbar-button basemap-button"
        aria-expanded={open}
        aria-controls={open ? 'basemap-options' : undefined}
        aria-label={t('basemap.menuAria', { name: currentName })}
        onClick={() => {
          if (!open) onOpen();
          setOpen(!open);
        }}
      >
        <Icon name="map" /><span>{currentName}</span>
      </button>
      {open ? (
        <div id="basemap-options" className="basemap-options" role="group" aria-label={t('basemap.title')}>
          <div className="basemap-group-label">{t('basemap.online')}</div>
          {ONLINE_BASEMAPS.map((basemap) => (
            <label key={basemap.id} className="basemap-option">
              <input type="radio" name="basemap" checked={value === basemap.id} onChange={() => choose(basemap.id)} />
              <span className={`basemap-swatch basemap-swatch-${basemap.id}`} aria-hidden="true" />
              <span>{t(basemap.labelKey)}</span>
            </label>
          ))}
          <div className="basemap-group-label">{t('basemap.offline')}</div>
          {tileSets.length ? tileSets.map((tileSet) => (
            <label key={tileSet.id} className="basemap-option">
              <input type="radio" name="basemap" checked={value === mbtilesBasemapId(tileSet.id)} onChange={() => choose(mbtilesBasemapId(tileSet.id))} />
              <span className="basemap-swatch basemap-swatch-offline" aria-hidden="true" />
              <span>{tileSet.name}<small>{t('basemap.zoomRange', { min: tileSet.minzoom, max: tileSet.maxzoom })}</small></span>
            </label>
          )) : <p className="basemap-empty">{t('basemap.offlineEmpty')}</p>}
        </div>
      ) : null}
    </div>
  );
}
