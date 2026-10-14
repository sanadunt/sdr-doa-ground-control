// Runs before the stylesheet so the embedded Receiver paints in the console's
// theme and language from the first frame. The console passes both in the
// iframe URL; the shared localStorage keys cover a direct visit.
(function () {
	var root = document.documentElement;
	var params = new URLSearchParams(window.location.search);
	var theme = params.get('theme');
	var lang = params.get('lang');
	try {
		if (theme !== 'light' && theme !== 'dark') theme = window.localStorage.getItem('sdr-console-theme');
		if (lang !== 'en' && lang !== 'id') lang = window.localStorage.getItem('sdr-console-lang');
	} catch (error) {
		// Storage can be blocked; fall back to the defaults below.
	}
	root.dataset.theme = theme === 'light' ? 'light' : 'dark';
	root.lang = lang === 'id' ? 'id' : 'en';
})();
