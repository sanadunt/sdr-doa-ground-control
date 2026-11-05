package com.sanadunt.groundview;

import android.Manifest;
import android.app.Activity;
import android.app.AlertDialog;
import android.app.DownloadManager;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.text.InputType;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.KeyEvent;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.view.WindowManager;
import android.view.inputmethod.EditorInfo;
import android.webkit.CookieManager;
import android.webkit.URLUtil;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.TextView;
import android.widget.Toast;
import com.sanadunt.groundview.core.Discovery;
import com.sanadunt.groundview.core.Probe;
import com.sanadunt.groundview.core.ProbeResult;
import java.util.List;

/**
 * Finds the groundstation's LAN view on this network and shows it full screen
 * in a WebView. The console itself decides what the tablet may do (the LAN
 * view is read only but for marker commands); this app only finds and opens it.
 */
public final class MainActivity extends Activity {
    /** The console's frontend needs this Chromium (Vite 7's default build target). */
    static final int MIN_WEBVIEW_MAJOR = 107;
    private static final String PREFS = "groundview";
    private static final String PREF_HOST = "host";
    private static final String PREF_PORT = "port";

    private FrameLayout root;
    private LinearLayout statusPanel;
    private TextView statusText;
    private ProgressBar progress;
    private Button primaryButton;
    private Button secondaryButton;
    private WebView webView;
    private View customView;
    private WebChromeClient.CustomViewCallback customViewCallback;

    /** host:port of the console the WebView shows, or null. */
    private String openAuthority;
    /** Bumped by every search, so an old search's answer is dropped. */
    private int searchGeneration;
    private boolean webViewChecked;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        buildViews();
        setContentView(root);
        enterFullScreen();
        start();
    }

    // ---- Views ----

    private void buildViews() {
        root = new FrameLayout(this);
        root.setBackgroundColor(getColor(R.color.background));

        statusPanel = new LinearLayout(this);
        statusPanel.setOrientation(LinearLayout.VERTICAL);
        statusPanel.setGravity(Gravity.CENTER);
        int pad = dp(32);
        statusPanel.setPadding(pad, pad, pad, pad);

        TextView title = new TextView(this);
        title.setText(R.string.app_name);
        title.setTextColor(getColor(R.color.accent));
        title.setTextSize(TypedValue.COMPLEX_UNIT_SP, 28);
        title.setGravity(Gravity.CENTER);
        statusPanel.addView(title, wrap());

        progress = new ProgressBar(this);
        progress.setIndeterminate(true);
        LinearLayout.LayoutParams progressParams = wrap();
        progressParams.topMargin = dp(24);
        statusPanel.addView(progress, progressParams);

        statusText = new TextView(this);
        statusText.setTextColor(getColor(R.color.text));
        statusText.setTextSize(TypedValue.COMPLEX_UNIT_SP, 18);
        statusText.setGravity(Gravity.CENTER);
        statusText.setMaxWidth(dp(560));
        LinearLayout.LayoutParams textParams = wrap();
        textParams.topMargin = dp(24);
        statusPanel.addView(statusText, textParams);

        LinearLayout buttons = new LinearLayout(this);
        buttons.setOrientation(LinearLayout.HORIZONTAL);
        buttons.setGravity(Gravity.CENTER);
        primaryButton = new Button(this);
        secondaryButton = new Button(this);
        primaryButton.setMinHeight(dp(48));
        secondaryButton.setMinHeight(dp(48));
        LinearLayout.LayoutParams buttonParams = wrap();
        buttonParams.setMargins(dp(8), 0, dp(8), 0);
        buttons.addView(primaryButton, buttonParams);
        buttons.addView(secondaryButton, new LinearLayout.LayoutParams(buttonParams));
        LinearLayout.LayoutParams buttonsParams = wrap();
        buttonsParams.topMargin = dp(32);
        statusPanel.addView(buttons, buttonsParams);

        root.addView(statusPanel, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT, Gravity.CENTER));
    }

    private LinearLayout.LayoutParams wrap() {
        return new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
    }

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }

    /** One state of the status screen: a text, a spinner or not, and up to two buttons. */
    private void showStatus(String text, boolean busy, int primaryLabel, Runnable primary, int secondaryLabel, Runnable secondary) {
        if (webView != null) {
            webView.setVisibility(View.GONE);
        }
        statusPanel.setVisibility(View.VISIBLE);
        statusText.setText(text);
        progress.setVisibility(busy ? View.VISIBLE : View.GONE);
        setButton(primaryButton, primaryLabel, primary);
        setButton(secondaryButton, secondaryLabel, secondary);
        if (primary != null) primaryButton.requestFocus();
    }

    private void setButton(Button button, int label, Runnable action) {
        if (action == null) {
            button.setVisibility(View.GONE);
            button.setOnClickListener(null);
            return;
        }
        button.setVisibility(View.VISIBLE);
        button.setText(label);
        button.setOnClickListener(v -> action.run());
    }

    // ---- Full screen ----

    @SuppressWarnings("deprecation")
    private void enterFullScreen() {
        if (Build.VERSION.SDK_INT >= 30) {
            getWindow().setDecorFitsSystemWindows(false);
            WindowInsetsController controller = getWindow().getInsetsController();
            if (controller != null) {
                controller.hide(WindowInsets.Type.systemBars());
                controller.setSystemBarsBehavior(WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
            }
        } else {
            getWindow().getDecorView().setSystemUiVisibility(
                    View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                            | View.SYSTEM_UI_FLAG_FULLSCREEN
                            | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                            | View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                            | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                            | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION);
        }
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) enterFullScreen();
    }

    // ---- Search ----

    private void start() {
        if (!webViewChecked) {
            webViewChecked = true;
            String version = webViewVersion();
            int major = majorVersion(version);
            if (major > 0 && major < MIN_WEBVIEW_MAJOR) {
                showStatus(getString(R.string.webview_old, version, MIN_WEBVIEW_MAJOR), false,
                        R.string.open_anyway, this::search, R.string.exit, this::finish);
                return;
            }
        }
        search();
    }

    private String webViewVersion() {
        try {
            PackageInfo info = WebView.getCurrentWebViewPackage();
            return info != null ? info.versionName : null;
        } catch (RuntimeException e) {
            return null;
        }
    }

    static int majorVersion(String version) {
        if (version == null) return -1;
        int dot = version.indexOf('.');
        try {
            return Integer.parseInt(dot > 0 ? version.substring(0, dot) : version);
        } catch (NumberFormatException e) {
            return -1;
        }
    }

    private void search() {
        final int generation = ++searchGeneration;
        showStatus(getString(R.string.searching), true, 0, null, R.string.enter_address, this::askAddress);
        final SharedPreferences prefs = getSharedPreferences(PREFS, MODE_PRIVATE);
        final String savedHost = prefs.getString(PREF_HOST, null);
        final int savedPort = prefs.getInt(PREF_PORT, Probe.DEFAULT_PORT);
        new Thread(() -> {
            // The last groundstation first: one quick question instead of a scan.
            if (savedHost != null) {
                ProbeResult saved = Probe.check(savedHost, savedPort, 1500, 3000);
                if (saved.kind == ProbeResult.Kind.CONSOLE) {
                    runOnUiThread(() -> {
                        if (generation == searchGeneration) open(saved);
                    });
                    return;
                }
            }
            Discovery.Result result = Discovery.run(Discovery.DEFAULT_NAME, Probe.DEFAULT_PORT, (done, total) ->
                    runOnUiThread(() -> {
                        if (generation == searchGeneration) {
                            statusText.setText(getString(R.string.searching) + "\n" + getString(R.string.scan_progress, done, total));
                        }
                    }));
            runOnUiThread(() -> {
                if (generation == searchGeneration) searchDone(result);
            });
        }, "groundstation-search").start();
    }

    private void searchDone(Discovery.Result result) {
        String local = localText(result.local);
        if (result.consoles.size() == 1) {
            open(result.consoles.get(0));
        } else if (result.consoles.size() > 1) {
            choose(result.consoles);
        } else if (!result.refused.isEmpty()) {
            showStatus(getString(R.string.refused, result.refused.get(0).address(), local), false,
                    R.string.search_again, this::search, R.string.enter_address, this::askAddress);
        } else if (result.local.isEmpty()) {
            showStatus(getString(R.string.no_network), false,
                    R.string.search_again, this::search, R.string.enter_address, this::askAddress);
        } else {
            showStatus(getString(R.string.not_found, local), false,
                    R.string.search_again, this::search, R.string.enter_address, this::askAddress);
        }
    }

    private static String localText(List<Discovery.LocalAddress> local) {
        if (local.isEmpty()) return "-";
        StringBuilder out = new StringBuilder();
        for (Discovery.LocalAddress a : local) {
            if (out.length() > 0) out.append(", ");
            out.append(a.address.getHostAddress());
        }
        return out.toString();
    }

    private void choose(List<ProbeResult> consoles) {
        String[] labels = new String[consoles.size()];
        for (int i = 0; i < labels.length; i++) {
            ProbeResult r = consoles.get(i);
            labels[i] = r.address() + (r.version != null ? "  ·  " + r.version : "");
        }
        showStatus(getString(R.string.choose), false, R.string.search_again, this::search, R.string.enter_address, this::askAddress);
        new AlertDialog.Builder(this)
                .setTitle(R.string.choose)
                .setItems(labels, (dialog, which) -> open(consoles.get(which)))
                .setNegativeButton(R.string.cancel, null)
                .show();
    }

    private void askAddress() {
        final EditText input = new EditText(this);
        input.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        input.setHint(R.string.address_hint);
        input.setSingleLine(true);
        input.setImeOptions(EditorInfo.IME_ACTION_GO);
        String savedHost = getSharedPreferences(PREFS, MODE_PRIVATE).getString(PREF_HOST, null);
        if (savedHost != null) {
            int savedPort = getSharedPreferences(PREFS, MODE_PRIVATE).getInt(PREF_PORT, Probe.DEFAULT_PORT);
            input.setText(Probe.authority(savedHost, savedPort));
            input.selectAll();
        }
        FrameLayout frame = new FrameLayout(this);
        int pad = dp(20);
        frame.setPadding(pad, dp(8), pad, 0);
        frame.addView(input);
        final AlertDialog dialog = new AlertDialog.Builder(this)
                .setTitle(R.string.enter_address)
                .setView(frame)
                .setPositiveButton(R.string.open, null)
                .setNegativeButton(R.string.cancel, null)
                .create();
        Runnable submit = () -> {
            String[] parsed = Probe.parseAddress(input.getText().toString());
            if (parsed == null) {
                input.setError(getString(R.string.address_invalid));
                return;
            }
            dialog.dismiss();
            checkAddress(parsed[0], Integer.parseInt(parsed[1]));
        };
        dialog.setOnShowListener(d -> dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener(v -> submit.run()));
        input.setOnEditorActionListener((v, actionId, event) -> {
            submit.run();
            return true;
        });
        dialog.show();
    }

    /** A typed address: open it when it is a LAN view, otherwise say what it answered. */
    private void checkAddress(String host, int port) {
        final int generation = ++searchGeneration;
        final String authority = Probe.authority(host, port);
        showStatus(getString(R.string.opening, authority), true, 0, null, R.string.cancel, this::search);
        new Thread(() -> {
            ProbeResult r = Probe.check(host, port, 3000, 5000);
            String local = localText(Discovery.localAddresses());
            runOnUiThread(() -> {
                if (generation != searchGeneration) return;
                if (r.kind == ProbeResult.Kind.CONSOLE) {
                    open(r);
                } else if (r.kind == ProbeResult.Kind.NOT_ALLOWED) {
                    showStatus(getString(R.string.refused, authority, local), false,
                            R.string.try_again, () -> checkAddress(host, port), R.string.search_again, this::search);
                } else {
                    showStatus(getString(R.string.unreachable, authority), false,
                            R.string.try_again, () -> checkAddress(host, port), R.string.search_again, this::search);
                }
            });
        }, "groundstation-check").start();
    }

    // ---- WebView ----

    private void open(ProbeResult console) {
        searchGeneration++;
        getSharedPreferences(PREFS, MODE_PRIVATE).edit()
                .putString(PREF_HOST, console.host)
                .putInt(PREF_PORT, console.port)
                .apply();
        openAuthority = console.address();
        WebView view = ensureWebView();
        statusPanel.setVisibility(View.GONE);
        view.setVisibility(View.VISIBLE);
        view.loadUrl("http://" + openAuthority + "/");
        view.requestFocus();
    }

    private WebView ensureWebView() {
        if (webView != null) return webView;
        webView = new WebView(this);
        webView.setBackgroundColor(getColor(R.color.background));
        WebSettings s = webView.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        // The audio mirror starts its AudioContext from the Dengar tap; let it play.
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setUseWideViewPort(true);
        s.setLoadWithOverviewMode(true);
        s.setSupportZoom(true);
        s.setBuiltInZoomControls(true);
        s.setDisplayZoomControls(false);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setGeolocationEnabled(false);
        s.setUserAgentString(s.getUserAgentString() + " SDR-DoA-Tablet/" + appVersion());
        CookieManager.getInstance().setAcceptCookie(true);

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                if (isConsole(uri)) return false;
                // Anything else (a map attribution link) opens in the browser.
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, uri));
                } catch (ActivityNotFoundException ignored) {
                    // No browser: stay on the console.
                }
                return true;
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (request.isForMainFrame()) showUnreachable();
            }

            @Override
            public void onReceivedHttpError(WebView view, WebResourceRequest request, WebResourceResponse response) {
                if (request.isForMainFrame() && response.getStatusCode() == 403) {
                    String local = localText(Discovery.localAddresses());
                    showStatus(getString(R.string.refused, openAuthority, local), false,
                            R.string.try_again, MainActivity.this::reload, R.string.search_again, MainActivity.this::search);
                }
            }
        });

        webView.setWebChromeClient(new WebChromeClient() {
            // A video the page puts in full screen (the drone camera).
            @Override
            public void onShowCustomView(View view, CustomViewCallback callback) {
                if (customView != null) {
                    callback.onCustomViewHidden();
                    return;
                }
                customView = view;
                customViewCallback = callback;
                root.addView(view, new FrameLayout.LayoutParams(
                        ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
                enterFullScreen();
            }

            @Override
            public void onHideCustomView() {
                hideCustomView();
            }
        });

        webView.setDownloadListener((url, userAgent, contentDisposition, mimeType, contentLength) ->
                download(url, userAgent, contentDisposition, mimeType));

        root.addView(webView, 0, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        return webView;
    }

    private boolean isConsole(Uri uri) {
        if (openAuthority == null || uri == null) return false;
        return "http".equals(uri.getScheme()) && openAuthority.equalsIgnoreCase(uri.getEncodedAuthority());
    }

    private void showUnreachable() {
        showStatus(getString(R.string.unreachable, openAuthority), false,
                R.string.try_again, this::reload, R.string.search_again, this::search);
    }

    private void reload() {
        if (webView == null || openAuthority == null) {
            search();
            return;
        }
        statusPanel.setVisibility(View.GONE);
        webView.setVisibility(View.VISIBLE);
        webView.loadUrl("http://" + openAuthority + "/");
    }

    private void hideCustomView() {
        if (customView == null) return;
        root.removeView(customView);
        customView = null;
        if (customViewCallback != null) customViewCallback.onCustomViewHidden();
        customViewCallback = null;
        enterFullScreen();
    }

    /** Records downloads (an <a download> link) go to Download/ through DownloadManager. */
    private void download(String url, String userAgent, String contentDisposition, String mimeType) {
        Uri uri = Uri.parse(url);
        if (!isConsole(uri)) return;
        if (Build.VERSION.SDK_INT < 29
                && checkSelfPermission(Manifest.permission.WRITE_EXTERNAL_STORAGE) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[] {Manifest.permission.WRITE_EXTERNAL_STORAGE}, 1);
            Toast.makeText(this, R.string.storage_needed, Toast.LENGTH_LONG).show();
            return;
        }
        String name = URLUtil.guessFileName(url, contentDisposition, mimeType);
        try {
            DownloadManager.Request request = new DownloadManager.Request(uri);
            request.setMimeType(mimeType);
            request.addRequestHeader("User-Agent", userAgent);
            String cookies = CookieManager.getInstance().getCookie(url);
            if (cookies != null) request.addRequestHeader("Cookie", cookies);
            request.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
            request.setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, name);
            DownloadManager manager = getSystemService(DownloadManager.class);
            manager.enqueue(request);
            Toast.makeText(this, getString(R.string.download_started, name), Toast.LENGTH_SHORT).show();
        } catch (RuntimeException e) {
            Toast.makeText(this, R.string.download_failed, Toast.LENGTH_LONG).show();
        }
    }

    private String appVersion() {
        try {
            return getPackageManager().getPackageInfo(getPackageName(), 0).versionName;
        } catch (PackageManager.NameNotFoundException e) {
            return "dev";
        }
    }

    // ---- Back and lifecycle ----

    @Override
    public boolean onKeyDown(int keyCode, KeyEvent event) {
        if (keyCode == KeyEvent.KEYCODE_BACK) {
            onBack();
            return true;
        }
        return super.onKeyDown(keyCode, event);
    }

    private void onBack() {
        if (customView != null) {
            hideCustomView();
            return;
        }
        boolean consoleShown = webView != null && webView.getVisibility() == View.VISIBLE;
        if (consoleShown && webView.canGoBack()) {
            webView.goBack();
            return;
        }
        if (!consoleShown) {
            finish();
            return;
        }
        new AlertDialog.Builder(this)
                .setTitle(R.string.leave_title)
                .setItems(new CharSequence[] {getString(R.string.find_other), getString(R.string.exit)}, (dialog, which) -> {
                    if (which == 0) {
                        // Forget the last one, or the search would open it again at once.
                        getSharedPreferences(PREFS, MODE_PRIVATE).edit().remove(PREF_HOST).remove(PREF_PORT).apply();
                        webView.loadUrl("about:blank");
                        openAuthority = null;
                        search();
                    } else {
                        finish();
                    }
                })
                .setNegativeButton(R.string.cancel, null)
                .show();
    }

    @Override
    protected void onPause() {
        super.onPause();
        if (webView != null) webView.onPause();
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (webView != null) webView.onResume();
        enterFullScreen();
    }

    @Override
    protected void onDestroy() {
        searchGeneration++;
        if (webView != null) {
            root.removeView(webView);
            webView.destroy();
            webView = null;
        }
        super.onDestroy();
    }

}
