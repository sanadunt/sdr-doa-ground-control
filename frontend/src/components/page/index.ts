// Page design kit for every page except the Dashboard and the Receiver.
// Styled by page-kit.css; the look follows the Dashboard (ov-* chips,
// buttons and segmented controls are reused as they are).
export { Page, PageGrid, PageStack, Toolbar, joinClasses } from './Layout';
export type { PageSpan } from './Layout';
export { PageHeader } from './PageHeader';
export { Card } from './Card';
export { StatRow, StatTile } from './StatTile';
export { KeyValueGrid } from './KeyValueGrid';
export type { KeyValueItem } from './KeyValueGrid';
export { StatusChip, Tag } from './StatusChip';
export { DataTable } from './DataTable';
export type { DataColumn } from './DataTable';
export { FileButton, FormField, FormGrid } from './FormField';
export { Segmented } from './Segmented';
export type { SegmentedOption } from './Segmented';
export { Switch } from './Switch';
export { EmptyState } from './EmptyState';
// PageNotice is the same component, for files that already import the Notice type from lib/errorNotice.
export { Notice, Notice as PageNotice } from './Notice';
export { PageReadAgeContext, usePageReadAge } from './pageContext';
export type { PageTone } from './pageContext';
