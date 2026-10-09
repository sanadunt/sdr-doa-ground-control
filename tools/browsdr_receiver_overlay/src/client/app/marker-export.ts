import type { ReceiverMarker } from './receiver-records-api';

export function serializeMarkerSet(name: string, markers: ReceiverMarker[], exportedAt = new Date().toISOString()): string {
	return JSON.stringify({
		format: 'browsdr-marker-set',
		version: 1,
		name: name.trim() || 'Markers',
		exported_at: exportedAt,
		markers: markers.map(marker => ({
			id: marker.id,
			frequency_hz: marker.frequencyHz,
			power_db: marker.powerDb,
			label: marker.label,
		})),
	}, null, 2);
}

function csvCell(value: string): string {
	return `"${value.replace(/"/g, '""')}"`;
}

export function exportMarkerSetCsv(markers: ReceiverMarker[]): string {
	const rows = markers.map(marker => [
		marker.id,
		String(marker.frequencyHz),
		marker.powerDb === null ? '' : String(marker.powerDb),
		marker.label,
	].map(csvCell).join(','));
	return ['marker_id,frequency_hz,power_db,label', ...rows].join('\r\n');
}
