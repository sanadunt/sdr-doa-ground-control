/**
 * Template of the Records archive (records-archive.ts), compiled at run time by Vue.
 * Every t() argument is a single-quoted literal or a ternary of literals, so the i18n
 * test finds each key. Row cells bind only fields of rowsView entries and t() literals;
 * labels, dates and sizes are prepared once per data or language change.
 */
export const RECORDS_ARCHIVE_TEMPLATE = /* html */ `
<div class="records-archive" :class="{ 'has-selection': selectionView.count > 0 }">
	<div class="archive-settings-bar">
		<label class="checkbox records-archive-switch archive-auto-switch">
			<input type="checkbox" role="switch" :checked="autoArchive" :disabled="scanBusy" @change="onAutoArchiveChange($event)">
			{{ t('Auto-archive scans') }}
		</label>
		<label class="archive-field archive-retention-field">
			<span class="archive-field-label">{{ t('Retention') }}</span>
			<select :value="retentionDraft" :disabled="!settings || busy.retention || busy.retentionPreview" @change="onRetentionChange($event)">
				<option v-if="!settings" value="">—</option>
				<option v-if="settings" value="off">{{ t('Off') }}</option>
				<option v-for="option in retentionOptions" :key="option.value" :value="option.value">{{ option.label }}</option>
			</select>
		</label>
		<div class="archive-storage">
			<span class="archive-value"><span class="archive-value-label">{{ t('Stored') }}</span><strong>{{ storedLabel }}</strong></span>
			<span class="archive-value"><span class="archive-value-label">{{ t('Free space') }}</span><strong>{{ freeLabel }}</strong></span>
			<span v-if="notRemovedLabel" class="archive-chip is-warn">{{ notRemovedLabel }}</span>
		</div>
		<button type="button" class="btn btn-secondary archive-refresh" :disabled="busy.refreshing" @click="refreshAll()">{{ t(busy.refreshing ? 'Refreshing…' : 'Refresh') }}</button>
	</div>

	<div v-if="retentionConfirmView" class="archive-confirm archive-retention-confirm" role="group" :aria-label="t('Retention')" @keydown.esc.stop.prevent="cancelConfirm()">
		<span class="archive-confirm-text"><strong>{{ t('Retention') }} {{ retentionConfirmView.optionLabel }}</strong><span>{{ t('Removed now') }}: {{ retentionConfirmView.countsLabel }}</span></span>
		<span class="archive-confirm-actions">
			<button type="button" class="btn btn-primary" :disabled="busy.retention" @click="applyRetention()">{{ t(busy.retention ? 'Applying…' : 'Apply') }}</button>
			<button type="button" class="btn" data-confirm-cancel :disabled="busy.retention" @click="cancelConfirm()">{{ t('Cancel') }}</button>
		</span>
	</div>

	<div v-if="loadErrorText" class="archive-notice is-bad" role="alert">
		<span>{{ loadErrorText }}</span>
		<button type="button" class="btn" @click="refreshAll()">{{ t('Retry') }}</button>
	</div>
	<div v-if="noticeText || readyExport" class="archive-notice" :class="noticeTone" role="status" aria-live="polite">
		<span v-if="noticeText">{{ noticeText }}</span>
		<a v-if="readyExport" class="btn btn-primary" :href="readyExport.url" :download="readyExport.filename" @click="onReadyExportClick()">{{ t('ZIP ready') }}</a>
		<button type="button" class="archive-dismiss" :aria-label="t('Dismiss message')" :title="t('Dismiss message')" @click="dismissNotice()">×</button>
	</div>

	<div class="archive-layout">
		<div class="archive-side">
			<section class="archive-card archive-calendar-card" :class="{ 'is-open': view.calendarOpen }" aria-labelledby="archive-month-label">
				<div class="archive-calendar-head">
					<button type="button" class="btn archive-icon-btn" :aria-label="t('Previous month')" :title="t('Previous month')" @click="changeMonth(-1)">
						<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M10 3.5 5.5 8l4.5 4.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"></path></svg>
					</button>
					<strong id="archive-month-label" class="archive-month-label">{{ monthLabel }}</strong>
					<button type="button" class="btn archive-icon-btn" :aria-label="t('Next month')" :title="t('Next month')" @click="changeMonth(1)">
						<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6 3.5 10.5 8 6 12.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"></path></svg>
					</button>
					<button type="button" class="btn archive-today" @click="goToday()">{{ t('Today') }}</button>
				</div>
				<div class="archive-segmented archive-mode-switch" role="group" :aria-label="t('Calendar')">
					<button type="button" :class="{ active: view.mode === 'day' }" :aria-pressed="view.mode === 'day'" @click="setMode('day')">{{ t('Day') }}</button>
					<button type="button" :class="{ active: view.mode === 'range' }" :aria-pressed="view.mode === 'range'" @click="setMode('range')">{{ t('Range') }}</button>
					<button type="button" :class="{ active: view.mode === 'all' }" :aria-pressed="view.mode === 'all'" @click="setMode('all')">{{ t('All dates') }}</button>
				</div>
				<div class="archive-calendar-grid" role="grid" aria-labelledby="archive-month-label">
					<div class="archive-week archive-weekdays" role="row">
						<span v-for="weekday in weekdayLabels" :key="weekday" role="columnheader">{{ weekday }}</span>
					</div>
					<div v-for="week in calendarWeeks" :key="week.key" class="archive-week" role="row">
						<span v-for="cell in week.cells" :key="cell.key" class="archive-day-cell" role="gridcell" :aria-selected="cell.selected ? 'true' : 'false'">
							<button type="button" class="archive-day" :class="cell.classes" :data-date="cell.key" :tabindex="cell.tabindex" :disabled="!cell.exists" :aria-label="cell.ariaLabel" :aria-current="cell.isToday ? 'date' : null" @click="pickDate(cell.key)" @keydown="onCalendarKey($event, cell.key)" @focus="view.focusedDate = cell.key">
								<span class="archive-day-number">{{ cell.day }}</span>
								<span class="archive-day-dots" aria-hidden="true"><span v-if="cell.hasAudio" class="archive-dot is-audio"></span><span v-if="cell.hasScan" class="archive-dot is-scan"></span></span>
							</button>
						</span>
					</div>
				</div>
				<div class="archive-legend" aria-hidden="true">
					<span><span class="archive-dot is-audio"></span>{{ t('Audio') }}</span>
					<span><span class="archive-dot is-scan"></span>{{ t('Scans') }}</span>
				</div>
			</section>

			<button type="button" class="btn archive-filters-toggle" :aria-expanded="view.filtersOpen ? 'true' : 'false'" aria-controls="archive-filters" @click="view.filtersOpen = !view.filtersOpen">{{ filtersButtonLabel }}</button>
			<section id="archive-filters" class="archive-card archive-filters-card" :class="{ 'is-open': view.filtersOpen }" aria-labelledby="archive-filters-title">
				<h3 id="archive-filters-title" class="archive-card-title">{{ t('Filters') }}</h3>
				<div class="archive-filter-grid">
					<div class="archive-field is-wide">
						<span class="archive-field-label" id="archive-type-label">{{ t('Type') }}</span>
						<div class="archive-segmented" role="group" aria-labelledby="archive-type-label">
							<button type="button" :class="{ active: filters.type === 'all' }" :aria-pressed="filters.type === 'all'" @click="setType('all')">{{ t('All') }}</button>
							<button type="button" :class="{ active: filters.type === 'audio' }" :aria-pressed="filters.type === 'audio'" @click="setType('audio')">{{ t('Audio') }}</button>
							<button type="button" :class="{ active: filters.type === 'scan' }" :aria-pressed="filters.type === 'scan'" @click="setType('scan')">{{ t('Scans') }}</button>
						</div>
					</div>
					<fieldset class="archive-field archive-pair is-wide">
						<legend class="archive-field-label">{{ t('Frequency (MHz)') }}</legend>
						<label><span class="visually-hidden">{{ t('Frequency (MHz)') }}</span><span class="archive-pair-label">{{ t('Min') }}</span><input type="number" min="0" step="any" inputmode="decimal" :value="filters.minMHz" :aria-invalid="frequencyErrors.min ? 'true' : 'false'" @change="setFrequency('min', $event)" @keydown.enter="setFrequency('min', $event)"></label>
						<label><span class="visually-hidden">{{ t('Frequency (MHz)') }}</span><span class="archive-pair-label">{{ t('Max') }}</span><input type="number" min="0" step="any" inputmode="decimal" :value="filters.maxMHz" :aria-invalid="frequencyErrors.max ? 'true' : 'false'" @change="setFrequency('max', $event)" @keydown.enter="setFrequency('max', $event)"></label>
					</fieldset>
					<label class="archive-field">
						<span class="archive-field-label">{{ t('Status') }}</span>
						<select :value="filters.status" @change="setFilter('status', $event)">
							<option value="">{{ t('All statuses') }}</option>
							<option v-for="status in statusOptions" :key="status.value" :value="status.value">{{ status.label }}</option>
						</select>
					</label>
					<label class="archive-field">
						<span class="archive-field-label">VFO</span>
						<select :value="filters.vfo" :disabled="filters.type === 'scan'" @change="setFilter('vfo', $event)">
							<option value="">{{ t('All VFOs') }}</option>
							<option v-for="vfo in vfoOptions" :key="vfo.value" :value="vfo.value">{{ vfo.label }}</option>
						</select>
					</label>
					<label class="archive-field">
						<span class="archive-field-label">{{ t('Mode') }}</span>
						<select :value="filters.mode" :disabled="filters.type === 'scan'" @change="setFilter('mode', $event)">
							<option value="">{{ t('All modes') }}</option>
							<option v-for="mode in modeOptions" :key="mode.value" :value="mode.value">{{ mode.label }}</option>
						</select>
					</label>
					<label class="archive-field">
						<span class="archive-field-label">{{ t('Bandwidth') }}</span>
						<select :value="filters.bandwidth" :disabled="filters.type === 'scan'" @change="setFilter('bandwidth', $event)">
							<option value="">{{ t('All bandwidths') }}</option>
							<option v-for="bandwidth in bandwidthOptions" :key="bandwidth.value" :value="bandwidth.value">{{ bandwidth.label }}</option>
						</select>
					</label>
					<fieldset v-if="view.mode !== 'day'" class="archive-field archive-pair is-wide" :disabled="timeOfDayDisabled">
						<legend class="archive-field-label">{{ t('Time of day (local)') }} <span v-if="timeOfDayState === 'too-many'" class="archive-chip is-warn">{{ t('Too many') }}</span></legend>
						<label><span class="archive-pair-label">{{ t('From') }}</span><input type="time" step="60" :value="filters.timeFrom" :aria-invalid="timeOfDayState === 'invalid' ? 'true' : 'false'" @change="setFilter('timeFrom', $event)"></label>
						<label><span class="archive-pair-label">{{ t('To') }}</span><input type="time" step="60" :value="filters.timeTo" :aria-invalid="timeOfDayState === 'invalid' ? 'true' : 'false'" @change="setFilter('timeTo', $event)"></label>
					</fieldset>
					<label class="archive-field is-wide">
						<span class="archive-field-label">{{ t('Search') }}</span>
						<input type="search" maxlength="64" autocomplete="off" spellcheck="false" :value="searchDraft" @input="onSearchInput($event)" @keydown.enter="applySearch()">
					</label>
					<button v-if="filtersSet" type="button" class="btn archive-clear-filters is-wide" @click="clearFilters()">{{ t('Clear filters') }}</button>
				</div>
			</section>
		</div>

		<div class="archive-main">
			<div class="archive-day-bar">
				<button type="button" class="btn archive-icon-btn" :disabled="!periodNav.prev" :aria-label="t(view.mode === 'range' ? 'Previous period' : 'Previous day')" :title="t(view.mode === 'range' ? 'Previous period' : 'Previous day')" @click="shiftPeriod(-1)">
					<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M10 3.5 5.5 8l4.5 4.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"></path></svg>
				</button>
				<h3 class="archive-day-label">{{ dayLabel }}</h3>
				<button type="button" class="btn archive-day-toggle" :aria-expanded="view.calendarOpen ? 'true' : 'false'" :aria-label="t('Calendar') + ': ' + dayLabel" @click="view.calendarOpen = !view.calendarOpen">{{ dayLabel }}</button>
				<button type="button" class="btn archive-icon-btn" :disabled="!periodNav.next" :aria-label="t(view.mode === 'range' ? 'Next period' : 'Next day')" :title="t(view.mode === 'range' ? 'Next period' : 'Next day')" @click="shiftPeriod(1)">
					<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6 3.5 10.5 8 6 12.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"></path></svg>
				</button>
				<span class="archive-day-values">{{ dayValues }}</span>
			</div>

			<section v-if="timelineView" class="archive-card archive-timeline-card" aria-labelledby="archive-timeline-title">
				<div class="archive-card-head">
					<h3 id="archive-timeline-title" class="archive-card-title">{{ t('Timeline') }}</h3>
					<span v-if="timelineView.truncated" class="archive-chip is-warn">{{ t('Partly shown') }}</span>
					<div class="archive-time-fields">
						<label><span class="archive-pair-label">{{ t('From') }}</span><input type="time" step="60" :value="timeFields.from" :aria-invalid="timeFields.invalid === 'from' ? 'true' : 'false'" @change="setTimeField('from', $event)"></label>
						<label><span class="archive-pair-label">{{ t('To') }}</span><input type="time" step="60" :value="timeFields.to" :aria-invalid="timeFields.invalid === 'to' ? 'true' : 'false'" @change="setTimeField('to', $event)"></label>
						<button type="button" class="btn" :disabled="!timeRange" @click="setTimeRange(null)">{{ t('Whole day') }}</button>
					</div>
				</div>
				<div class="archive-timeline">
					<div class="archive-timeline-rows" aria-hidden="true"><span>{{ t('Audio') }}</span><span>{{ t('Scans') }}</span></div>
					<div class="archive-timeline-plot" tabindex="0" role="group" :aria-label="timelineView.ariaLabel" @pointerdown="onTimelinePointerDown($event)" @pointermove="onTimelinePointerMove($event)" @pointerup="onTimelinePointerUp($event)" @pointercancel="onTimelinePointerCancel()" @keydown="onTimelineKey($event)">
						<svg class="archive-timeline-svg" :viewBox="timelineView.viewBox" preserveAspectRatio="none" aria-hidden="true">
							<rect class="archive-tl-lane" x="0" y="4" :width="timelineView.width" height="24"></rect>
							<rect class="archive-tl-lane" x="0" y="36" :width="timelineView.width" height="24"></rect>
							<line v-for="x in timelineView.hourLines" :key="x" class="archive-tl-hour" :x1="x" :x2="x" y1="0" y2="64"></line>
							<rect v-for="(bar, index) in timelineView.audioBars" :key="'a' + index" class="archive-tl-bar is-audio" :x="bar.x" y="6" :width="bar.width" height="20"></rect>
							<rect v-for="(bar, index) in timelineView.scanBars" :key="'s' + index" class="archive-tl-bar is-scan" :x="bar.x" y="38" :width="bar.width" height="20"></rect>
							<rect v-if="timelineView.selection" class="archive-tl-selection" :x="timelineView.selection.x" y="1" :width="timelineView.selection.width" height="62"></rect>
							<line v-if="timelineView.nowX !== null" class="archive-tl-now" :x1="timelineView.nowX" :x2="timelineView.nowX" y1="0" y2="64"></line>
						</svg>
						<div class="archive-timeline-ticks" aria-hidden="true">
							<span v-for="tick in timelineView.ticks" :key="tick.ms" :class="{ 'is-minor': tick.minor }" :style="{ left: tick.pct + '%' }">{{ tick.label }}</span>
						</div>
					</div>
				</div>
			</section>

			<div class="archive-toolbar" :class="{ 'is-sticky': selectionView.count > 0 }">
				<label class="archive-check archive-page-check">
					<input type="checkbox" :checked="pageSelection === 'all'" :indeterminate="pageSelection === 'some'" :disabled="!pageHasSelectable" @change="togglePage()">
					<span>{{ t('Select page') }}</span>
				</label>
				<span v-if="selectionView.count > 0" class="archive-selection-count">{{ selectionView.text }}</span>
				<button v-if="selectionView.canSelectAll" type="button" class="btn" @click="selectAll()">{{ selectionView.selectAllLabel }}</button>
				<span v-if="selectionView.allSelectedLabel" class="archive-selection-count">{{ selectionView.allSelectedLabel }}</span>
				<span class="archive-toolbar-actions">
					<button type="button" class="btn btn-primary" :disabled="!selectionView.canDownload || busy.exporting" @click="downloadSelection()">{{ t(busy.exporting ? 'Preparing ZIP…' : 'Download ZIP') }}</button>
					<span v-if="selectionView.tooLarge" class="archive-chip is-warn">{{ t('Too large') }}</span>
					<button type="button" class="btn btn-danger" :disabled="!selectionView.canDelete || busy.deleting" @click="askDeleteSelection()">{{ t('Delete') }}</button>
					<span v-if="selectionView.tooMany" class="archive-chip is-warn">{{ t('Too many') }}</span>
					<button v-if="selectionView.count > 0" type="button" class="btn" @click="clearSelection()">{{ t('Clear selection') }}</button>
				</span>
				<span v-if="busy.items && loadedOnce" class="archive-chip">{{ t('Loading…') }}</span>
				<span class="archive-range-label">{{ rangeLabel }}</span>
			</div>
			<div v-if="selectionConfirmView" class="archive-confirm" role="group" :aria-label="t('Delete the selected records?')" @keydown.esc.stop.prevent="cancelConfirm()">
				<span class="archive-confirm-text"><strong>{{ t('Delete the selected records?') }}</strong><span>{{ selectionConfirmView.label }}</span></span>
				<span class="archive-confirm-actions">
					<button type="button" class="btn btn-danger" :disabled="busy.deleting" @click="confirmDeleteSelection()">{{ t(busy.deleting ? 'Deleting…' : 'Delete') }}</button>
					<button type="button" class="btn" data-confirm-cancel :disabled="busy.deleting" @click="cancelConfirm()">{{ t('Cancel') }}</button>
				</span>
			</div>

			<div class="archive-table-region" role="region" :aria-label="t('Archive records')" :aria-busy="busy.items ? 'true' : 'false'">
				<table class="archive-table">
					<thead>
						<tr>
							<th scope="col" class="col-check"><span class="visually-hidden">{{ t('Select') }}</span></th>
							<th scope="col" class="col-start" :aria-sort="sortAria.start"><button type="button" class="archive-sort" @click="sortBy('start')">{{ t('Start') }}<span class="archive-sort-mark" aria-hidden="true">{{ sortMarks.start }}</span></button></th>
							<th scope="col" class="col-end" :aria-sort="sortAria.end"><button type="button" class="archive-sort" @click="sortBy('end')">{{ t('End') }}<span class="archive-sort-mark" aria-hidden="true">{{ sortMarks.end }}</span></button></th>
							<th scope="col" class="col-type" :aria-sort="sortAria.type"><button type="button" class="archive-sort" @click="sortBy('type')">{{ t('Type') }}<span class="archive-sort-mark" aria-hidden="true">{{ sortMarks.type }}</span></button></th>
							<th scope="col" class="col-frequency" :aria-sort="sortAria.frequency"><button type="button" class="archive-sort" @click="sortBy('frequency')">{{ t('Frequency') }}<span class="archive-sort-mark" aria-hidden="true">{{ sortMarks.frequency }}</span></button></th>
							<th scope="col" class="col-mode">{{ t('Mode') }}</th>
							<th scope="col" class="col-duration" :aria-sort="sortAria.duration"><button type="button" class="archive-sort" @click="sortBy('duration')">{{ t('Duration') }}<span class="archive-sort-mark" aria-hidden="true">{{ sortMarks.duration }}</span></button></th>
							<th scope="col" class="col-size" :aria-sort="sortAria.size"><button type="button" class="archive-sort" @click="sortBy('size')">{{ t('Size') }}<span class="archive-sort-mark" aria-hidden="true">{{ sortMarks.size }}</span></button></th>
							<th scope="col" class="col-status" :aria-sort="sortAria.status"><button type="button" class="archive-sort" @click="sortBy('status')">{{ t('Status') }}<span class="archive-sort-mark" aria-hidden="true">{{ sortMarks.status }}</span></button></th>
							<th scope="col" class="col-actions">{{ t('Actions') }}</th>
						</tr>
					</thead>
					<tbody>
						<tr v-if="!loadedOnce" class="archive-state-row"><td colspan="10">{{ t('Loading…') }}</td></tr>
						<tr v-else-if="emptyState" class="archive-state-row">
							<td colspan="10">
								<span>{{ t(emptyState.key === 'day' ? 'No records on this day.' : emptyState.key === 'period' ? 'No records in this period.' : emptyState.key === 'filters' ? 'No records match these filters.' : 'No records yet.') }}</span>
								<button v-if="emptyState.action === 'latest'" type="button" class="btn" @click="goLatest()">{{ t('Latest') }}</button>
								<button v-if="emptyState.action === 'clear'" type="button" class="btn" @click="clearFilters()">{{ t('Clear filters') }}</button>
							</td>
						</tr>
						<template v-for="row in rowsView" :key="row.key">
							<tr class="archive-row" :class="row.classes">
								<td class="col-check"><label class="archive-check-cell"><input type="checkbox" :checked="row.selected" :disabled="!row.selectable" :aria-label="row.checkAria" @change="toggleRow(row)"></label></td>
								<td class="col-start"><span v-if="row.startDate" class="archive-date">{{ row.startDate }}</span><time :datetime="row.startIso">{{ row.startTime }}</time><span v-if="row.phoneEnd" class="archive-phone-end">–{{ row.phoneEnd }}</span></td>
								<td class="col-end"><span v-if="row.endDate" class="archive-date">{{ row.endDate }}</span><span>{{ row.endTime }}</span></td>
								<td class="col-type">
									<span class="archive-type">{{ row.typeLabel }}</span>
									<span v-if="row.sourceLabel" class="archive-sub archive-source">{{ row.sourceLabel }}</span>
									<span v-if="row.simulated" class="archive-chip is-warn">SIMULATION</span>
									<span class="archive-sub archive-type-mode">{{ row.modeLabel }}</span>
								</td>
								<td class="col-frequency">{{ row.frequencyLabel }}</td>
								<td class="col-mode">{{ row.modeLabel }}</td>
								<td class="col-duration">{{ row.durationLabel }}</td>
								<td class="col-size">{{ row.sizeLabel }}</td>
								<td class="col-status">
									<span class="archive-status" :class="row.statusClass" :title="row.statusTitle || null">{{ row.statusCode }}</span>
									<span v-if="row.notSavedLabel" class="archive-chip is-warn">{{ row.notSavedLabel }}</span>
								</td>
								<td class="col-actions">
									<span class="archive-actions">
										<button v-if="row.kind === 'audio'" type="button" class="btn archive-icon-btn archive-action" :disabled="!row.playable" :aria-label="row.playAria" :aria-pressed="row.playing ? 'true' : 'false'" :title="row.playAria" @click="togglePlay(row)">
											<svg v-if="row.playing" viewBox="0 0 16 16" aria-hidden="true"><rect x="4" y="3.5" width="3" height="9" rx="0.5" fill="currentColor"></rect><rect x="9" y="3.5" width="3" height="9" rx="0.5" fill="currentColor"></rect></svg>
											<svg v-else viewBox="0 0 16 16" aria-hidden="true"><path d="M5 3.2v9.6l7.6-4.8z" fill="currentColor"></path></svg>
											<span class="archive-action-label">{{ t(row.playing ? 'Pause' : 'Play') }}</span>
										</button>
										<button v-else type="button" class="btn archive-icon-btn archive-action" :disabled="!row.previewable" :aria-label="row.previewAria" :aria-expanded="row.previewed ? 'true' : 'false'" :title="row.previewAria" @click="togglePreview(row)">
											<svg viewBox="0 0 16 16" aria-hidden="true"><polyline points="1.5,12.5 4,9 6,10.5 8.5,3.5 10.5,8 12.5,6.5 14.5,12.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"></polyline></svg>
											<span class="archive-action-label">{{ t('Preview') }}</span>
										</button>
										<a v-if="row.downloadUrl" class="btn archive-icon-btn archive-action" :href="row.downloadUrl" download :aria-label="row.downloadAria" :title="row.downloadAria">
											<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 2.5v7.5M4.8 7 8 10.2 11.2 7M3 13h10" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"></path></svg>
											<span class="archive-action-label">{{ t('Download') }}</span>
										</a>
										<button v-else type="button" class="btn archive-icon-btn archive-action" disabled :aria-label="row.downloadAria">
											<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 2.5v7.5M4.8 7 8 10.2 11.2 7M3 13h10" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"></path></svg>
											<span class="archive-action-label">{{ t('Download') }}</span>
										</button>
										<button type="button" class="btn btn-danger archive-icon-btn archive-action" :disabled="!row.deletable || busy.deleting" :aria-label="row.deleteAria" :title="row.deleteAria" @click="askDeleteRow(row)">
											<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.8 4.5h10.4M6.3 4.5V2.8h3.4v1.7M4.4 4.5l.7 8.7h5.8l.7-8.7" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"></path></svg>
											<span class="archive-action-label">{{ t('Delete') }}</span>
										</button>
									</span>
								</td>
							</tr>
							<tr v-if="row.confirming" class="archive-detail-row archive-confirm-row">
								<td colspan="10">
									<div class="archive-confirm" role="group" :aria-label="t('Delete this record?')" @keydown.esc.stop.prevent="cancelConfirm()">
										<span class="archive-confirm-text"><strong>{{ t('Delete this record?') }}</strong><span>{{ row.label }}</span></span>
										<span class="archive-confirm-actions">
											<button type="button" class="btn btn-danger" :disabled="busy.deleting" @click="confirmDeleteRow()">{{ t(busy.deleting ? 'Deleting…' : 'Delete') }}</button>
											<button type="button" class="btn" data-confirm-cancel :disabled="busy.deleting" @click="cancelConfirm()">{{ t('Cancel') }}</button>
										</span>
									</div>
								</td>
							</tr>
							<tr v-if="row.preview" class="archive-detail-row archive-preview-row">
								<td colspan="10">
									<div v-if="row.kind === 'audio'" class="archive-preview">
										<audio class="archive-audio" controls preload="metadata" :src="row.preview.audioUrl" @play="onAudioState(true)" @pause="onAudioState(false)" @ended="onAudioState(false)"></audio>
										<dl class="archive-kv">
											<div v-for="entry in row.preview.details" :key="entry.key"><dt>{{ entry.label }}</dt><dd>{{ entry.value }}</dd></div>
										</dl>
										<p v-if="row.preview.errorText" class="archive-preview-error">{{ row.preview.errorText }}</p>
									</div>
									<div v-else class="archive-preview is-scan">
										<p v-if="row.preview.loading" class="archive-preview-state">{{ t('Loading…') }}</p>
										<p v-else-if="row.preview.errorText" class="archive-preview-error" role="alert">{{ row.preview.errorText }}</p>
										<div v-else class="archive-scan-preview">
											<div class="archive-trace">
												<div class="archive-trace-plot">
													<span class="archive-trace-db is-top">{{ row.preview.topLabel }}</span>
													<span class="archive-trace-db is-bottom">{{ row.preview.bottomLabel }}</span>
													<svg v-if="row.preview.maxPoints" viewBox="0 0 511 100" preserveAspectRatio="none" aria-hidden="true">
														<polyline class="archive-trace-max" :points="row.preview.maxPoints"></polyline>
														<polyline class="archive-trace-mean" :points="row.preview.meanPoints"></polyline>
													</svg>
												</div>
												<div class="archive-trace-axis"><span>{{ row.preview.startLabel }}</span><span>{{ row.preview.endLabel }}</span></div>
												<div class="archive-legend"><span><span class="archive-line is-max"></span>{{ t('Max') }}</span><span><span class="archive-line is-mean"></span>{{ t('Average') }}</span></div>
											</div>
											<div class="archive-scan-side">
												<dl class="archive-kv">
													<div v-for="entry in row.preview.details" :key="entry.key"><dt>{{ entry.label }}</dt><dd>{{ entry.value }}</dd></div>
												</dl>
												<table v-if="row.preview.candidates.length" class="archive-candidates">
													<thead><tr><th scope="col">{{ t('Frequency') }} MHz</th><th scope="col">{{ t('Peak') }} dB</th><th scope="col">SNR dB</th></tr></thead>
													<tbody><tr v-for="candidate in row.preview.candidates" :key="candidate.key"><td>{{ candidate.frequency }}</td><td>{{ candidate.peak }}</td><td>{{ candidate.snr }}</td></tr></tbody>
												</table>
												<div v-if="row.openConfirmText" class="archive-confirm" role="group" :aria-label="t('Open in Spectrum')" @keydown.esc.stop.prevent="cancelConfirm()">
													<span class="archive-confirm-text"><strong>{{ row.openConfirmText }}</strong></span>
													<span class="archive-confirm-actions">
														<button type="button" class="btn btn-primary" :disabled="scanBusy" @click="confirmOpenScan()">{{ t('Open') }}</button>
														<button type="button" class="btn" data-confirm-cancel @click="cancelConfirm()">{{ t('Cancel') }}</button>
													</span>
												</div>
												<button v-else type="button" class="btn btn-primary archive-open-scan" :disabled="scanBusy" @click="openScan(row)">{{ t('Open in Spectrum') }}</button>
											</div>
										</div>
									</div>
								</td>
							</tr>
						</template>
					</tbody>
				</table>
			</div>

			<div class="archive-pager">
				<button type="button" class="btn" :disabled="page === 0 || busy.items" @click="goPage(page - 1)">{{ t('Previous') }}</button>
				<span class="archive-page-label">{{ t('Page') }} {{ page + 1 }} {{ t('of') }} {{ pageTotal }}</span>
				<button type="button" class="btn" :disabled="page + 1 >= pageTotal || busy.items" @click="goPage(page + 1)">{{ t('Next') }}</button>
				<label class="archive-field archive-page-size">
					<span class="archive-field-label">{{ t('Rows per page') }}</span>
					<select :value="String(pageSize)" @change="setPageSize($event)">
						<option v-for="size in pageSizes" :key="size" :value="String(size)">{{ size }}</option>
					</select>
				</label>
			</div>
		</div>
	</div>
</div>
`;
