export type ArchiveUploadKind = 'trace' | 'candidates';

/**
 * Remembers the Records error banner each kind of archive upload set, so that a later
 * successful upload of the same kind clears it. A banner set by anything else stays.
 */
export class ArchiveUploadBanner {
	private readonly shown = new Map<ArchiveUploadKind, string>();

	failed(kind: ArchiveUploadKind, banner: string): string {
		this.shown.set(kind, banner);
		return banner;
	}

	/** The banner to show after a successful upload. */
	succeeded(kind: ArchiveUploadKind, currentBanner: string): string {
		const ours = this.shown.get(kind);
		this.shown.delete(kind);
		return ours !== undefined && currentBanner === ours ? '' : currentBanner;
	}
}
