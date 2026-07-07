package com.yehang.paotuan;

import android.Manifest;
import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.view.View;
import android.view.WindowInsets;
import android.webkit.PermissionRequest;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import androidx.webkit.WebViewAssetLoader;
import java.util.ArrayList;

public class MainActivity extends Activity {
    private static final String APP_URL = "https://appassets.androidplatform.net/assets/www/index.html";
    private static final String APP_ASSET_HOST = "appassets.androidplatform.net";
    private static final int REQUEST_AUDIO = 5101;
    private static final int REQUEST_FILE_CHOOSER = 5102;

    private WebView webView;
    private WebViewAssetLoader assetLoader;
    private PermissionRequest pendingPermissionRequest;
    private ValueCallback<Uri[]> pendingFilePathCallback;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        WebView.setWebContentsDebuggingEnabled(false);
        webView = new WebView(this);
        FrameLayout root = new FrameLayout(this);
        root.addView(webView, new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.MATCH_PARENT
        ));
        applySystemBarInsets(root);
        setContentView(root);
        root.requestApplyInsets();
        assetLoader = new WebViewAssetLoader.Builder()
                .addPathHandler("/assets/", new WebViewAssetLoader.AssetsPathHandler(this))
                .build();

        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setMediaPlaybackRequiresUserGesture(false);
        String userAgent = settings.getUserAgentString();
        if (userAgent == null || !userAgent.contains("YehangPaotuanAndroid")) {
            settings.setUserAgentString((userAgent == null ? "" : userAgent) + " YehangPaotuanAndroid/1.0");
        }
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(true);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
            settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        }

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                return assetLoader.shouldInterceptRequest(request.getUrl());
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                return handleUrl(request.getUrl());
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, String url) {
                return handleUrl(Uri.parse(url));
            }
        });

        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onPermissionRequest(PermissionRequest request) {
                handlePermissionRequest(request);
            }

            @Override
            public boolean onShowFileChooser(
                    WebView view,
                    ValueCallback<Uri[]> filePathCallback,
                    FileChooserParams fileChooserParams
            ) {
                if (pendingFilePathCallback != null) {
                    pendingFilePathCallback.onReceiveValue(null);
                }
                pendingFilePathCallback = filePathCallback;

                String[] acceptTypes = resolveAcceptTypes(fileChooserParams);
                Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
                intent.addCategory(Intent.CATEGORY_OPENABLE);
                applyAcceptTypes(intent, acceptTypes);
                try {
                    startActivityForResult(intent, REQUEST_FILE_CHOOSER);
                    return true;
                } catch (ActivityNotFoundException error) {
                    try {
                        Intent fallbackIntent = new Intent(Intent.ACTION_GET_CONTENT);
                        fallbackIntent.addCategory(Intent.CATEGORY_OPENABLE);
                        applyAcceptTypes(fallbackIntent, acceptTypes);
                        startActivityForResult(Intent.createChooser(fallbackIntent, "Select file"), REQUEST_FILE_CHOOSER);
                        return true;
                    } catch (ActivityNotFoundException fallbackError) {
                        try {
                            Intent webViewIntent = fileChooserParams.createIntent();
                            applyAcceptTypes(webViewIntent, acceptTypes);
                            startActivityForResult(webViewIntent, REQUEST_FILE_CHOOSER);
                            return true;
                        } catch (ActivityNotFoundException webViewError) {
                            pendingFilePathCallback = null;
                            filePathCallback.onReceiveValue(null);
                            return false;
                        }
                    }
                }
            }
        });

        webView.loadUrl(APP_URL);
    }

    private void applySystemBarInsets(View view) {
        getWindow().setStatusBarColor(Color.rgb(246, 247, 251));
        getWindow().setNavigationBarColor(Color.WHITE);

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            view.setOnApplyWindowInsetsListener((target, insets) -> {
                android.graphics.Insets bars = insets.getInsets(WindowInsets.Type.systemBars());
                target.setPadding(bars.left, bars.top, bars.right, bars.bottom);
                return insets;
            });
            return;
        }

        view.setFitsSystemWindows(true);
    }

    private boolean handleUrl(Uri uri) {
        if (isAppAssetUri(uri)) {
            return false;
        }
        openExternal(uri);
        return true;
    }

    private boolean isAppAssetUri(Uri uri) {
        String host = uri.getHost();
        String scheme = uri.getScheme();
        return APP_ASSET_HOST.equals(host) && "https".equals(scheme);
    }

    private void openExternal(Uri uri) {
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, uri));
        } catch (ActivityNotFoundException error) {
            // Keep untrusted or unsupported URLs out of the app WebView even when Android has no handler.
        }
    }

    private void handlePermissionRequest(PermissionRequest request) {
        if (!isAppAssetUri(request.getOrigin())) {
            request.deny();
            return;
        }
        for (String resource : request.getResources()) {
            if (PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(resource)) {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M
                        && checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
                    pendingPermissionRequest = request;
                    requestPermissions(new String[]{Manifest.permission.RECORD_AUDIO}, REQUEST_AUDIO);
                    return;
                }
                request.grant(new String[]{PermissionRequest.RESOURCE_AUDIO_CAPTURE});
                return;
            }
        }
        request.deny();
    }

    private String[] resolveAcceptTypes(WebChromeClient.FileChooserParams fileChooserParams) {
        String[] acceptTypes = fileChooserParams != null ? fileChooserParams.getAcceptTypes() : null;
        if (acceptTypes == null || acceptTypes.length == 0) {
            return new String[]{"*/*"};
        }
        ArrayList<String> normalizedTypes = new ArrayList<>();
        for (String type : acceptTypes) {
            if (type == null) {
                continue;
            }
            for (String item : type.split(",")) {
                String trimmed = item.trim();
                if (trimmed.isEmpty()) {
                    continue;
                }
                if (trimmed.startsWith(".")) {
                    return new String[]{"*/*"};
                }
                if (!normalizedTypes.contains(trimmed)) {
                    normalizedTypes.add(trimmed);
                }
            }
        }
        return normalizedTypes.isEmpty() ? new String[]{"*/*"} : normalizedTypes.toArray(new String[0]);
    }

    private void applyAcceptTypes(Intent intent, String[] acceptTypes) {
        if (acceptTypes == null || acceptTypes.length == 0) {
            intent.setType("*/*");
            return;
        }
        if (acceptTypes.length == 1) {
            intent.setType(acceptTypes[0]);
            return;
        }
        intent.setType(commonAcceptType(acceptTypes));
        intent.putExtra(Intent.EXTRA_MIME_TYPES, acceptTypes);
    }

    private String commonAcceptType(String[] acceptTypes) {
        boolean imageOnly = true;
        for (String type : acceptTypes) {
            if (type == null || !type.startsWith("image/")) {
                imageOnly = false;
                break;
            }
        }
        return imageOnly ? "image/*" : "*/*";
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode != REQUEST_FILE_CHOOSER || pendingFilePathCallback == null) {
            return;
        }

        ValueCallback<Uri[]> callback = pendingFilePathCallback;
        pendingFilePathCallback = null;
        callback.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(resultCode, data));
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode != REQUEST_AUDIO || pendingPermissionRequest == null) {
            return;
        }
        PermissionRequest request = pendingPermissionRequest;
        pendingPermissionRequest = null;
        if (grantResults.length > 0 && grantResults[0] == PackageManager.PERMISSION_GRANTED) {
            request.grant(new String[]{PermissionRequest.RESOURCE_AUDIO_CAPTURE});
        } else {
            request.deny();
        }
    }

    @Override
    public void onBackPressed() {
        if (webView == null) {
            super.onBackPressed();
            return;
        }
        webView.evaluateJavascript(
            "(function(){try{return !!(window.__PAOTUAN_HANDLE_NATIVE_BACK__&&window.__PAOTUAN_HANDLE_NATIVE_BACK__());}catch(e){return false;}})();",
            handled -> {
                if ("true".equals(handled)) {
                    return;
                }
                moveTaskToBack(true);
            }
        );
    }

    @Override
    protected void onDestroy() {
        if (pendingFilePathCallback != null) {
            pendingFilePathCallback.onReceiveValue(null);
            pendingFilePathCallback = null;
        }
        if (webView != null) {
            webView.destroy();
            webView = null;
        }
        super.onDestroy();
    }
}
