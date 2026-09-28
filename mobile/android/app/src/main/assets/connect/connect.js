(function () {
  "use strict";
  var bridge = window.AutomaNative;
  var form = document.getElementById("connect-form");
  var input = document.getElementById("server");
  var button = document.getElementById("connect");
  var errorBox = document.getElementById("error");
  var recentSection = document.getElementById("recent-section");
  var recentList = document.getElementById("recent");
  var pending = {};
  var counter = 0;

  window.__automaNative = {
    resolve: function (callId, payload) {
      var done = pending[callId];
      delete pending[callId];
      if (!done) return;
      try { done(JSON.parse(payload)); } catch (e) { done({ ok: false, error: "Unexpected reply from the app" }); }
    },
  };

  function showError(message) {
    errorBox.textContent = message || "";
    errorBox.hidden = !message;
  }

  function setBusy(busy) {
    button.disabled = busy;
    button.textContent = busy ? "Connecting…" : "Connect";
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

  function connect(address) {
    if (!bridge) { showError("Open this screen in the Automa app."); return; }
    var value = (address || "").trim();
    if (!value) { showError("Enter your Automa server address."); input.focus(); return; }
    showError("");
    setBusy(true);
    setPose("thinking");
    counter += 1;
    var callId = "connect-" + counter;
    pending[callId] = function (reply) {
      if (!reply || reply.ok === false) {
        setBusy(false);
        setPose("confused");
        if (bridge.haptic) bridge.haptic("warning");
        var message = (reply && reply.error) || "Could not connect.";
        showError(message);
        // Aimed at this phone (its own address or 127.0.0.1): show how to run Automa here.
        if (/this phone/i.test(message)) openThisPhone();
        return;
      }
      setPose("success");
      if (bridge.haptic) bridge.haptic("success");
      // On success the app opens the server itself.
    };
    bridge.connect(value, callId);
  }

  form.addEventListener("submit", function (event) {
    event.preventDefault();
    if (bridge && bridge.haptic) bridge.haptic("tick");
    connect(input.value);
  });

  // ─── Run Automa on this phone (Termux) ─────────────────────────────────
  var termuxButton = document.getElementById("termux");
  var termuxStatus = document.getElementById("termux-status");
  if (bridge && bridge.isTermuxInstalled && bridge.isTermuxInstalled()) {
    termuxButton.textContent = "Open Termux";
    termuxStatus.textContent = "Termux is installed.";
  }
  termuxButton.addEventListener("click", function () {
    if (bridge && bridge.openTermux) bridge.openTermux();
  });
  var copyButton = document.getElementById("copy-setup");
  copyButton.addEventListener("click", function () {
    var text = document.getElementById("setup-cmd").textContent;
    if (bridge && bridge.copyText) bridge.copyText(text);
    else if (navigator.clipboard) navigator.clipboard.writeText(text);
    if (bridge && bridge.haptic) bridge.haptic("tick");
    copyButton.textContent = "Copied";
    setTimeout(function () { copyButton.textContent = "Copy commands"; }, 2000);
  });
  document.getElementById("connect-local").addEventListener("click", function () {
    input.value = "127.0.0.1:3100";
    if (bridge && bridge.haptic) bridge.haptic("tick");
    connect(input.value);
  });
  document.getElementById("chip-this-phone").addEventListener("click", openThisPhone);

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
        bridge.forgetServer(url);
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
    try { return JSON.parse(bridge.getAuthState()) || { enabled: false, user: null }; } catch (e) { return { enabled: false, user: null }; }
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
    if (bridge.haptic) bridge.haptic("tick");
    counter += 1;
    var callId = "google-" + counter;
    pending[callId] = function (reply) {
      googleButton.disabled = false;
      googleLabel.textContent = "Continue with Google";
      if (!reply || reply.ok === false) {
        signinError.textContent = (reply && reply.error) || "Google sign-in did not finish.";
        signinError.hidden = false;
        if (bridge.haptic) bridge.haptic("warning");
        return;
      }
      if (bridge.haptic) bridge.haptic("success");
      renderAccount(readAuthState());
      if (recentSection.hidden && !input.value) input.focus();
    };
    bridge.signInWithGoogle(callId);
  });

  document.getElementById("signout").addEventListener("click", function () {
    if (bridge && bridge.signOut) bridge.signOut();
    renderAccount(readAuthState());
  });

  renderAccount(readAuthState());

  var params = new URLSearchParams(location.search);
  if (params.get("error")) { showError(params.get("error")); setPose("confused"); }

  if (bridge && bridge.getConnectState) {
    try {
      var state = JSON.parse(bridge.getConnectState());
      if (state) {
        if (state.serverUrl) input.value = state.serverUrl;
        renderRecent(state.recent || []);
        document.getElementById("version").textContent = "Automa for Android " + state.appVersion;
      }
    } catch (e) { /* first run */ }
  }

  // First run: put the cursor in the address field so typing can start at
  // once. With saved servers, leave the keyboard down: one tap on a recent
  // server connects.
  if (!serverStep.hidden && recentSection.hidden && !input.value) input.focus();
})();
