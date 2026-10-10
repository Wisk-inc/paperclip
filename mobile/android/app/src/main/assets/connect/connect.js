(function () {
  "use strict";
  var bridge = window.AutomaNative;
  // The page key the app hands this page before any script runs; every bridge
  // call carries it, so frames the app did not open can't use the bridge.
  var KEY = typeof window.__automaKey === "string" ? window.__automaKey : "";
  var form = document.getElementById("connect-form");
  var input = document.getElementById("server");
  var button = document.getElementById("connect");
  var errorBox = document.getElementById("error");
  var recentSection = document.getElementById("recent-section");
  var recentList = document.getElementById("recent");
  var pending = {};
  var counter = 0;
  var LOCAL = "127.0.0.1:3100";

  window.__automaNative = {
    resolve: function (callId, payload) {
      var done = pending[callId];
      delete pending[callId];
      if (!done) return;
      try { done(JSON.parse(payload)); } catch (e) { done({ ok: false, error: "Unexpected reply from the app" }); }
    },
  };

  function haptic(kind) { if (bridge && bridge.haptic) bridge.haptic(KEY, kind); }
  function nextCall(prefix, done) { counter += 1; var callId = prefix + "-" + counter; pending[callId] = done; return callId; }

  function showError(message) {
    errorBox.textContent = message || "";
    errorBox.hidden = !message;
  }

  function setBusy(busy, label) {
    button.disabled = busy;
    button.textContent = busy ? (label || "Connecting…") : "Connect";
  }

  // The mascot reacts: listening → thinking while connecting → cheering or confused.
  var mascotPoses = document.querySelectorAll("#mascot img");
  function setPose(pose) {
    mascotPoses.forEach(function (img) { img.classList.toggle("on", img.getAttribute("data-pose") === pose); });
  }

  var thisPhone = document.getElementById("this-phone");
  function openThisPhone() {
    thisPhone.open = true;
    thisPhone.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  /**
   * Connects once. `appKey` (optional) is the key of a locked Automa on this
   * phone, pasted from `automa link`. Calls back with the reply.
   */
  function connectOnce(address, appKey, done) {
    var value = (address || "").trim();
    var callId = nextCall("connect", done);
    if (appKey) bridge.connectWithKey(KEY, value, appKey, callId);
    else bridge.connect(KEY, value, callId);
  }

  /**
   * The success screen. The app opens Automa itself a moment later (see
   * finishConnect in MainActivity); this is what shows meanwhile: where you
   * connected, what runs there, and where you are being taken.
   */
  function showConnected(reply) {
    var panel = document.getElementById("connected");
    var onPhone = /^https?:\/\/(127\.0\.0\.1|localhost)(:|$)/.test(reply.url || "");
    var host = (reply.url || "").replace(/^https?:\/\//, "");
    document.getElementById("connected-title").textContent = onPhone ? "Automa is running on this phone" : "Connected to Automa";
    document.getElementById("connected-detail").textContent = reply.firstRun
      ? "Everything is set up. Next comes a short setup: name your organization and hire your first agent."
      : onPhone ? "Your agents run right here, in Termux." : "Your agents are reachable at " + host + ".";
    var facts = document.getElementById("connected-facts");
    facts.innerHTML = "";
    [
      onPhone ? "On this phone" : host,
      reply.version ? "Automa " + reply.version : null,
      reply.locked ? "Locked to this app" : null,
      reply.insecure ? "Plain HTTP" : (reply.url || "").indexOf("https://") === 0 ? "HTTPS" : null,
    ].forEach(function (fact) {
      if (!fact) return;
      var li = document.createElement("li");
      li.textContent = fact;
      facts.appendChild(li);
    });
    document.getElementById("connected-next").textContent = reply.firstRun ? "Taking you to setup…" : "Opening your board…";
    panel.hidden = false;
  }

  function connect(address, appKey) {
    if (!bridge) { showError("Open this screen in the Automa app."); return; }
    var value = (address || "").trim();
    if (!value) { showError("Enter your Automa server address."); input.focus(); return; }
    showError("");
    setBusy(true);
    setPose("thinking");
    connectOnce(value, appKey, function (reply) {
      if (!reply || reply.ok === false) {
        setBusy(false);
        setPose("confused");
        haptic("warning");
        var message = (reply && reply.error) || "Could not connect.";
        showError(message);
        // Aimed at this phone (its own address or 127.0.0.1): show how to run Automa here.
        if (/this phone/i.test(message)) openThisPhone();
        return;
      }
      setPose("success");
      haptic("success");
      showConnected(reply);
      // The app opens the server itself once the success screen has shown.
    });
  }

  form.addEventListener("submit", function (event) {
    event.preventDefault();
    haptic("tick");
    connect(input.value);
  });

  // ─── A connect request from Termux (or another app) ───────────────────
  // The app never applies it by itself: the address (and app key) take effect
  // only when Connect is tapped here. Automa in Termux can take a minute to
  // start, so that tap keeps trying until it answers.
  var requested = document.getElementById("requested");
  var waitTimer = null;
  var waitTries = 0;
  function stopWaiting() {
    if (waitTimer) clearTimeout(waitTimer);
    waitTimer = null;
    waitTries = 0;
    setBusy(false);
  }
  function connectWaiting(address) {
    if (!bridge) return;
    showError("");
    setPose("thinking");
    waitTries += 1;
    setBusy(true, "Waiting for Automa to start in Termux… (" + waitTries + ")");
    connectOnce(address, null, function (reply) {
      if (reply && reply.ok !== false) {
        stopWaiting();
        setPose("success");
        haptic("success");
        showConnected(reply);
        return;
      }
      var message = (reply && reply.error) || "Could not connect.";
      // Not up yet (refused, still starting): try again shortly, for a while.
      if (waitTries < 40 && /not running|nothing answers|still starting|try again|refused/i.test(message)) {
        waitTimer = setTimeout(function () { connectWaiting(address); }, 3000);
        return;
      }
      stopWaiting();
      setPose("confused");
      haptic("warning");
      showError(message);
    });
  }
  function renderRequested(request) {
    requested.hidden = !request;
    if (!request) return;
    document.getElementById("requested-url").textContent = request.url.replace(/^https?:\/\//, "");
    document.getElementById("requested-detail").textContent = request.withKey
      ? "Termux is handing over the app key for Automa on this phone. Tap Connect if you just ran automa run or automa link; otherwise dismiss it."
      : "Tap Connect if you expected this (for example, you just linked a computer over ADB); otherwise dismiss it.";
    input.value = request.url.replace(/^https?:\/\//, "");
    requested.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }
  document.getElementById("requested-connect").addEventListener("click", function () {
    haptic("tick");
    connectWaiting(input.value);
  });
  document.getElementById("requested-dismiss").addEventListener("click", function () {
    haptic("tick");
    stopWaiting();
    if (bridge && bridge.dismissRequested) bridge.dismissRequested(KEY);
    requested.hidden = true;
  });

  // ─── Run Automa on this phone (Termux) ─────────────────────────────────
  var termuxButton = document.getElementById("termux");
  var termuxStatus = document.getElementById("termux-status");
  if (bridge && bridge.isTermuxInstalled && bridge.isTermuxInstalled(KEY)) {
    termuxButton.textContent = "Open Termux";
    termuxStatus.textContent = "Termux is installed.";
  }
  termuxButton.addEventListener("click", function () {
    if (bridge && bridge.openTermux) bridge.openTermux(KEY);
  });
  var sendButton = document.getElementById("send-server");
  var sendStatus = document.getElementById("send-status");
  if (!(bridge && bridge.hasServerBundle && bridge.hasServerBundle(KEY))) {
    sendButton.disabled = true;
    sendStatus.textContent = "This build of Automa does not include the phone server.";
  }
  sendButton.addEventListener("click", function () {
    if (!bridge || !bridge.sendServerToTermux) return;
    sendButton.disabled = true;
    sendButton.textContent = "Sending…";
    bridge.sendServerToTermux(KEY, nextCall("send-server", function (reply) {
      sendButton.disabled = false;
      sendButton.textContent = "Send again";
      sendStatus.textContent = reply && reply.ok
        ? "Sent. In Termux, tap Open directory, then paste the command below."
        : (reply && reply.error) || "Could not send it to Termux.";
    }));
  });
  function copyButton(buttonId, sourceId) {
    var el = document.getElementById(buttonId);
    el.addEventListener("click", function () {
      var text = document.getElementById(sourceId).textContent;
      if (bridge && bridge.copyText) bridge.copyText(KEY, text);
      else if (navigator.clipboard) navigator.clipboard.writeText(text);
      haptic("tick");
      el.textContent = "Copied";
      setTimeout(function () { el.textContent = "Copy command"; }, 2000);
    });
  }
  copyButton("copy-setup", "setup-cmd");
  copyButton("copy-adb", "adb-cmd");
  document.getElementById("connect-local").addEventListener("click", function () {
    input.value = LOCAL;
    haptic("tick");
    connect(input.value);
  });
  var appKeyField = document.getElementById("app-key");
  document.getElementById("connect-with-key").addEventListener("click", function () {
    var appKey = appKeyField.value.trim();
    if (!appKey) { appKeyField.focus(); return; }
    input.value = LOCAL;
    haptic("tick");
    connect(input.value, appKey);
  });
  document.getElementById("chip-this-phone").addEventListener("click", openThisPhone);

  // Link a computer with ADB (USB or Wireless debugging): adb reverse makes
  // the computer's Automa answer on this phone's 127.0.0.1.
  var adbSection = document.getElementById("adb");
  document.getElementById("chip-adb").addEventListener("click", function () {
    adbSection.open = true;
    adbSection.scrollIntoView({ behavior: "smooth", block: "start" });
  });
  document.querySelectorAll(".dev-options").forEach(function (devButton) {
    devButton.addEventListener("click", function () {
      haptic("tick");
      if (bridge && bridge.openDeveloperOptions) bridge.openDeveloperOptions(KEY);
    });
  });
  document.querySelectorAll(".wireless-debugging").forEach(function (wirelessButton) {
    wirelessButton.addEventListener("click", function () {
      haptic("tick");
      if (bridge && bridge.openWirelessDebugging) bridge.openWirelessDebugging(KEY);
      else if (bridge && bridge.openDeveloperOptions) bridge.openDeveloperOptions(KEY);
    });
  });
  document.getElementById("connect-adb").addEventListener("click", function () {
    input.value = LOCAL;
    haptic("tick");
    connect(input.value);
  });

  document.querySelectorAll("[data-fill]").forEach(function (chip) {
    chip.addEventListener("click", function () {
      input.value = chip.getAttribute("data-fill");
      input.focus();
    });
  });

  function renderRecent(list) {
    recentList.innerHTML = "";
    recentSection.hidden = !list.length;
    list.forEach(function (url) {
      var item = document.createElement("li");
      var open = document.createElement("button");
      open.type = "button";
      open.className = "open";
      open.textContent = url.replace(/^https?:\/\//, "");
      open.title = url;
      open.addEventListener("click", function () { input.value = url; connect(url); });
      var remove = document.createElement("button");
      remove.type = "button";
      remove.className = "remove";
      remove.setAttribute("aria-label", "Forget " + url);
      remove.textContent = "×";
      remove.addEventListener("click", function () {
        bridge.forgetServer(KEY, url);
        renderRecent(list.filter(function (entry) { return entry !== url; }));
      });
      item.appendChild(open);
      item.appendChild(remove);
      recentList.appendChild(item);
    });
  }

  // ─── Account (Firebase "Continue with Google") ────────────────────────
  var signinSection = document.getElementById("signin");
  var serverStep = document.getElementById("server-step");
  var googleButton = document.getElementById("google");
  var googleLabel = document.getElementById("google-label");
  var signinError = document.getElementById("signin-error");
  var account = document.getElementById("account");

  function readAuthState() {
    if (!bridge || !bridge.getAuthState) return { enabled: false, user: null };
    try { return JSON.parse(bridge.getAuthState(KEY)) || { enabled: false, user: null }; } catch (e) { return { enabled: false, user: null }; }
  }

  function renderAccount(state) {
    var needsSignIn = state.enabled && !state.user;
    signinSection.hidden = !needsSignIn;
    // The sign-up step carries its own Terms and Privacy line.
    document.querySelector(".footer").hidden = needsSignIn;
    serverStep.hidden = needsSignIn;
    account.hidden = !state.user;
    if (state.user) {
      document.getElementById("account-name").textContent = state.user.name || state.user.email || "Signed in";
      document.getElementById("account-email").textContent = state.user.name ? (state.user.email || "") : "";
      var photo = document.getElementById("account-photo");
      if (state.user.photoUrl) { photo.src = state.user.photoUrl; photo.hidden = false; } else { photo.hidden = true; }
    }
  }

  googleButton.addEventListener("click", function () {
    if (!bridge || !bridge.signInWithGoogle) return;
    signinError.hidden = true;
    googleButton.disabled = true;
    googleLabel.textContent = "Signing in…";
    haptic("tick");
    bridge.signInWithGoogle(KEY, nextCall("google", function (reply) {
      googleButton.disabled = false;
      googleLabel.textContent = "Continue with Google";
      if (!reply || reply.ok === false) {
        signinError.textContent = (reply && reply.error) || "Google sign-in did not finish.";
        signinError.hidden = false;
        haptic("warning");
        return;
      }
      haptic("success");
      renderAccount(readAuthState());
      if (recentSection.hidden && !input.value) input.focus();
    }));
  });

  document.getElementById("signout").addEventListener("click", function () {
    if (bridge && bridge.signOut) bridge.signOut(KEY);
    renderAccount(readAuthState());
  });

  renderAccount(readAuthState());

  var params = new URLSearchParams(location.search);
  if (params.get("error")) { showError(params.get("error")); setPose("confused"); }

  var state = null;
  if (bridge && bridge.getConnectState) {
    try { state = JSON.parse(bridge.getConnectState(KEY)); } catch (e) { /* first run */ }
  }
  if (state) {
    if (state.serverUrl) input.value = state.serverUrl;
    renderRecent(state.recent || []);
    document.getElementById("version").textContent = "Automa for Android " + state.appVersion;
    if (state.phoneAddress) {
      document.querySelectorAll(".phone-ip").forEach(function (el) { el.textContent = state.phoneAddress; });
    }
    if (state.requested) renderRequested(state.requested);
  }

  // First run: put the cursor in the address field so typing can start at
  // once. With saved servers, leave the keyboard down: one tap on a recent
  // server connects.
  if (!serverStep.hidden && recentSection.hidden && !input.value && requested.hidden) input.focus();
})();
