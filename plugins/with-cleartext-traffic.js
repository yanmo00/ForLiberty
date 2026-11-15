// Expo config plugin（必须用 CommonJS .js：Expo 的静态插件用 require 解析，不认 .ts）。
//
// Android 9+ 的 release 包默认禁止明文 HTTP（usesCleartextTraffic=false）。
// 自建网关 / EasyTier 虚拟网这类 http:// 地址（例 http://10.126.126.1:3425/v1）
// 会被系统在网络层直接拦掉，App 里只看到 "Network request failed"，
// 和 Key、模型名、跨域都无关。这里显式打开明文许可。
//
// 只影响 Android 原生构建；Web 预览走本机代理，不受此限制。
// 改动配置后必须重新打包 APK 才会生效（已装的老包仍被系统拦）。
const { withAndroidManifest } = require("expo/config-plugins");

module.exports = function withCleartextTraffic(config) {
  return withAndroidManifest(config, (mod) => {
    const application = mod.modResults.manifest.application?.[0];
    if (application) {
      if (!application.$) application.$ = { "android:name": ".MainApplication" };
      application.$["android:usesCleartextTraffic"] = "true";

      // SDK 54 的 edgeToEdgeEnabled 下，若不是 adjustResize，窗口不会随键盘缩短，
      // KeyboardAvoidingView 拿不到正确的可视高度，输入框会被键盘盖住。
      const activities = Array.isArray(application.activity) ? application.activity : [];
      for (const activity of activities) {
        if (!activity.$) activity.$ = {};
        activity.$["android:windowSoftInputMode"] = "adjustResize";
      }
    }
    return mod;
  });
};
