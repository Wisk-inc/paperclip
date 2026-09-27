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

  function connect(address) {
    if (!bridge) { showError("Open this screen in the Automa app."); return; }
    var value = (address || "").trim();
    if (!value) { showError("Enter your Automa server address."); input.focus(); return; }
    showError("");
    setBusy(true);
    counter += 1;
    var callId = "connect-" + counter;
    pending[callId] = function (reply) {
      if (!reply || reply.ok === false) {
        setBusy(false);
        showError((reply && reply.error) || "Could not connect.");
      }
      // On success the app opens the server itself.
    };
    bridge.connect(value, callId);
  }

  form.addEventListener("submit", function (event) {
    event.preventDefault();
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
        bridge.forgetServer(url);
        renderRecent(list.filter(function (entry) { return entry !== url; }));
      });
      item.appendChild(open);
      item.appendChild(remove);
      recentList.appendChild(item);
    });
  }

  var params = new URLSearchParams(location.search);
  if (params.get("error")) showError(params.get("error"));

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
})();
