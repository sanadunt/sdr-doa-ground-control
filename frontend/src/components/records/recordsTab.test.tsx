import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { translate } from '../../lib/i18n';
import type { MessageKey } from '../../lib/i18n';
import type { ArchiveScanPreview } from '../../lib/recordsArchiveApi';
import { ScanPreview } from './RecordsTab';

const t = (key: MessageKey, vars?: Record<string, string | number>) => translate('en', key, vars);

const PREVIEW_A: ArchiveScanPreview = {
  id: 'aaaaaaaa-0000-4000-8000-000000000001', start_hz: 100e6, end_hz: 200e6, bins: 3, trace_format: 1, trace_count: 12,
  traces_used: 12, traces_skipped: 0, max_db: [-60, -40, -60], mean_db: [-70, -55, -70],
  candidates: [{ frequency_hz: 150e6, peak_db: -40, snr_db: 30, bandwidth_hz: 12_500 }],
};
const SCAN_B = 'bbbbbbbb-0000-4000-8000-000000000002';

describe('scan preview', () => {
  it("draws a scan's own preview", () => {
    const markup = renderToStaticMarkup(<ScanPreview t={t} scanId={PREVIEW_A.id} preview={{ key: 'preview-a', data: PREVIEW_A, error: null, loading: false }} />);
    expect(markup).toContain('100.000000 MHz – 200.000000 MHz');
    expect(markup).toContain('12 of 12 sweeps');
    expect(markup).toContain('<polyline');
  });

  it("never draws another scan's preview under this row while its own loads", () => {
    const markup = renderToStaticMarkup(<ScanPreview t={t} scanId={SCAN_B} preview={{ key: 'preview-a', data: PREVIEW_A, error: null, loading: true }} />);
    expect(markup).toContain(t('records.previewLoading'));
    expect(markup).not.toContain('<polyline');
    expect(markup).not.toContain('150.000000 MHz');
    expect(markup).not.toContain('12 of 12 sweeps');
  });
});
