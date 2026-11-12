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
    // The message sits under the form; with the keyboard up it can be off screen.
    if (message && errorBox.scrollIntoView) errorBox.scrollIntoView({ behavior: "smooth", block: "nearest" });
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
  // Automa on this phone is locked to the app and the app has no key yet.
  function openAppKey() {
    var section = document.getElementById("app-key-section");
    thisPhone.open = true;
    section.open = true;
    section.scrollIntoView({ behavior: "smooth", block: "center" });
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
      : reply.signIn
        ? "This server has its own accounts: sign in next, with your email and password."
        : onPhone ? "Your agents run right here, in Termux." : "Your agents are reachable at " + host + ".";
    var facts = document.getElementById("connected-facts");
    facts.innerHTML = "";
    [
      onPhone ? "On this phone" : host,
      reply.version ? "Automa " + reply.version : null,
      reply.locked ? "Locked to this app" : null,
      reply.signIn ? "Sign-in required" : null,
      reply.insecure ? "Plain HTTP" : (reply.url || "").indexOf("https://") === 0 ? "HTTPS" : null,
    ].forEach(function (fact) {
      if (!fact) return;
      var li = document.createElement("li");
      li.textContent = fact;
      facts.appendChild(li);
    });
    var warning = document.getElementById("connected-warning");
    warning.hidden = !reply.insecure;
    document.getElementById("connected-next").textContent = nextStepText(reply);
    panel.hidden = false;
  }

  /** Where the app goes after connecting: setup on a fresh install, the sign-in page, or the board. */
  function nextStepText(reply) {
    return reply.firstRun ? "Taking you to setup…" : reply.signIn ? "Taking you to sign in…" : "Opening your board…";
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
        var message = (reply && reply.error) || "Could not connect.";
        // Automa on this phone answered but is still starting: wait for it here,
        // with the progress steps, instead of an error.
        if (/still starting/i.test(message) && isThisPhone(value) && !appKey) {
          setBusy(false);
          connectWaiting(value, false);
          return;
        }
        setBusy(false);
        setPose("confused");
        haptic("warning");
        showError(message);
        // Aimed at this phone (its own address or 127.0.0.1): show how to run Automa here,
        // and where to paste the key when it is locked to the app.
        if (/this phone/i.test(message)) openThisPhone();
        if (/automa link/i.test(message)) openAppKey();
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
  var waitBox = document.getElementById("wait");
  var waitStatus = document.getElementById("wait-status");
  var waitFill = document.getElementById("wait-fill");
  var waitBar = waitFill.parentNode;
  var waitHelp = document.getElementById("wait-help");
  var waitTermux = document.getElementById("wait-termux");
  var waitFix = document.getElementById("wait-fix");
  var waitFixCommand = document.getElementById("wait-fix-command");
  var waitTime = document.getElementById("wait-time");
  var lastWaitAddress = "";
  var waitTimer = null;
  var fillTimer = null;
  var tries = 0;
  var waitStarted = 0;
  var stepStarted = 0;
  var step = "termux";
  var startedTermux = false;
  // Termux is asked to start Automa only once a first try finds nothing
  // answering: a moment of silence (Android paused Termux, Automa restarting)
  // used to send the start request straight away, to an Automa already up.
  var startTermuxIfSilent = false;
  // A try is on its way to Automa (only one at a time).
  var inFlight = false;
  // Automa answered during this wait (it said it is starting up). Silence after
  // that is not "still starting": it stopped, and the page says so.
  var answered = false;
  var silentTries = 0;
  var silentSince = 0;
  // Termux was asked to start Automa again after it went silent (once per silence).
  var askedRestart = false;
  // What Automa last said it is doing: {label, seconds, stepSeconds, number, total}.
  var startup = null;
  // The help line is about silence (it goes when Automa answers again).
  var silenceHelp = false;
  var RETRY_MS = 3000;
  // Tries in a row with no answer, after Automa had answered, before the page
  // says it stopped (about ten seconds).
  var SILENT_TRIES_BEFORE_HELP = 3;
  // How long the page waits while nothing answers before it stops and says
  // what to do. While Automa answers that it is starting up, the page keeps
  // waiting: it shows what Automa is doing and for how long.
  var GIVE_UP_SILENT_MS = 5 * 60 * 1000;
  // Automa on one step this long is called out, with what to do.
  var STUCK_STEP_SECONDS = 5 * 60;
  // Each step owns a stretch of the bar. Within a step the bar creeps on
  // toward the step's end, so a slow start still shows movement, and jumps
  // ahead the moment the step is done. While Automa says which of its startup
  // steps it is on, the bar follows those instead.
  var STEPS = ["termux", "answer", "ready", "open"];
  var SPAN = { termux: [0, 30], answer: [30, 65], ready: [65, 90], open: [90, 100] };
  var fillFloor = 0;
  function stepState(name, state) {
    var item = waitBox.querySelector('[data-step="' + name + '"]');
    if (item) item.setAttribute("data-state", state);
  }
  // `back`: Automa stopped answering after it had, so "Automa answers" is the
  // step again; otherwise the steps only move forward.
  function setStep(name, status, back) {
    if (!back && STEPS.indexOf(name) < STEPS.indexOf(step)) name = step;
    if (name !== step) {
      stepStarted = Date.now();
      if (STEPS.indexOf(name) < STEPS.indexOf(step)) fillFloor = 0;
    }
    step = name;
    STEPS.forEach(function (other) {
      var item = waitBox.querySelector('[data-step="' + other + '"]');
      if (!item || item.getAttribute("data-state") === "skipped") return;
      var at = STEPS.indexOf(other);
      var now = STEPS.indexOf(name);
      item.setAttribute("data-state", at < now ? "done" : at === now ? "active" : "todo");
    });
    if (status) waitStatus.textContent = status;
    drawFill();
  }
  function drawFill() {
    var span = SPAN[step];
    var within;
    if (step === "open") {
      within = 1;
    } else if (step === "ready" && startup && startup.number && startup.total) {
      within = Math.min(1, (startup.number - 0.5) / startup.total);
    } else {
      within = 1 - Math.exp(-((Date.now() - stepStarted) / 1000) / 12);
    }
    var value = Math.max(fillFloor, Math.round(span[0] + (span[1] - span[0]) * 0.92 * within));
    fillFloor = value;
    waitFill.style.width = value + "%";
    waitBar.setAttribute("aria-valuenow", String(value));
    drawTime();
  }
  /** "45 s", "2 min 05 s". */
  function duration(seconds) {
    var whole = Math.max(0, Math.round(seconds));
    if (whole < 60) return whole + " s";
    var rest = whole % 60;
    return Math.floor(whole / 60) + " min" + (rest ? " " + (rest < 10 ? "0" : "") + rest + " s" : "");
  }
  function drawTime() {
    if (!waitTime) return;
    if (waitBox.hidden || !waitStarted) {
      waitTime.textContent = "";
      return;
    }
    var text = "Waiting " + duration((Date.now() - waitStarted) / 1000);
    if (step === "ready" && startup && startup.number && startup.total) {
      text += " · step " + startup.number + " of " + startup.total;
    }
    waitTime.textContent = text;
  }
  function setHelp(text, offerTermux) {
    waitHelp.textContent = text || "";
    waitHelp.hidden = !text;
    waitTermux.hidden = !offerTermux;
    silenceHelp = false;
  }
  function setSilenceHelp(text) {
    setHelp(text, true);
    silenceHelp = true;
  }
  // Termux refused (allow-external-apps is off): show the one-line fix
  // instead of asking it again, which only makes Termux pop an error report.
  function showAllowFix(command) {
    if (command) waitFixCommand.textContent = command;
    waitFix.hidden = false;
    setHelp("", false);
  }
  function resetWaitState() {
    tries = 0;
    startedTermux = false;
    startTermuxIfSilent = false;
    answered = false;
    silentTries = 0;
    silentSince = 0;
    askedRestart = false;
    startup = null;
    fillFloor = 0;
  }
  function stopWaiting() {
    waitFix.hidden = true;
    if (waitTimer) clearTimeout(waitTimer);
    if (fillTimer) clearInterval(fillTimer);
    waitTimer = null;
    fillTimer = null;
    resetWaitState();
    waitBox.hidden = true;
    drawTime();
    setBusy(false);
  }
  function beginWaiting(canStartTermux) {
    resetWaitState();
    waitBox.hidden = false;
    waitStarted = Date.now();
    stepStarted = waitStarted;
    step = canStartTermux ? "termux" : "answer";
    stepState("termux", canStartTermux ? "todo" : "skipped");
    setHelp("", false);
    setStep(step, canStartTermux ? "Getting ready…" : "Waiting for Automa on this phone to answer…");
    if (fillTimer) clearInterval(fillTimer);
    fillTimer = setInterval(drawFill, 250);
  }
  function isThisPhone(address) {
    return /^(https?:\/\/)?(127\.0\.0\.1|localhost)(:|\/|$)/.test((address || "").trim());
  }
  // Termux can be asked without Android asking the person first.
  function canAskTermuxQuietly() {
    return !!(bridge && bridge.startAutomaInTermux && bridge.isTermuxInstalled && bridge.isTermuxInstalled(KEY) &&
      bridge.termuxRunPermissionGranted && bridge.termuxRunPermissionGranted(KEY) && isThisPhone(lastWaitAddress));
  }
  // Asks Termux to start Automa (`automa start`), saying what it waits on:
  // Android's permission dialog the first time, then Termux's answer.
  function startInTermux(then, retry) {
    startedTermux = true;
    var granted = bridge.termuxRunPermissionGranted && bridge.termuxRunPermissionGranted(KEY);
    setStep("termux", granted ? "Waiting for confirmation from Termux…" : "Waiting for your OK: allow Automa to run commands in Termux.");
    var start = retry && bridge.retryAutomaInTermux ? bridge.retryAutomaInTermux : bridge.startAutomaInTermux;
    start.call(bridge, KEY, nextCall("termux-start", function (reply) {
      if (reply && reply.ok !== false) {
        waitFix.hidden = true;
        setStep("answer", reply.pending ? "Asked Termux to start Automa. Waiting for it to answer…" : "Termux started Automa. Waiting for it to answer…");
      } else if (reply && reply.reason === "not_allowed") {
        showAllowFix(reply.fix);
        setStep("answer", "Waiting for Automa. Fix the Termux setting below, or run automa run in Termux.");
      } else {
        var reason = reply && reply.reason;
        setHelp((reply && reply.error) || "Termux didn't start Automa.", reason !== "not_set_up" && reason !== "not_installed");
        if (reason === "not_set_up" || reason === "not_installed") openThisPhone();
        setStep("answer", "Waiting for Automa to answer. Start it in Termux if it isn't running.");
      }
      then();
    }));
  }
  // `startTermux`: Automa on this phone is down and nobody is starting it, so
  // ask Termux to. Not for a request Termux itself sent (automa run is
  // already starting it there).
  function connectWaiting(address, startTermux) {
    if (!bridge) return;
    lastWaitAddress = address;
    showError("");
    setPose("thinking");
    if (waitBox.hidden) {
      var canStart = !!startTermux && isThisPhone(address) && !!bridge.startAutomaInTermux && !!(bridge.isTermuxInstalled && bridge.isTermuxInstalled(KEY));
      beginWaiting(canStart);
      setBusy(true, "Waiting for Automa…");
      startTermuxIfSilent = canStart && !startedTermux;
    }
    if (inFlight) return;
    if (waitTimer) {
      clearTimeout(waitTimer);
      waitTimer = null;
    }
    tries += 1;
    tryOnce(address);
  }
  function tryLater(address) {
    if (waitTimer) clearTimeout(waitTimer);
    waitTimer = setTimeout(function () {
      waitTimer = null;
      // A try already on its way schedules the next one itself.
      if (inFlight || waitBox.hidden) return;
      tries += 1;
      tryOnce(address);
    }, RETRY_MS);
  }
  /** What Automa said it is doing, from the app's reply (older servers send none of it). */
  function startupOf(reply) {
    if (!reply || (typeof reply.step !== "string" && typeof reply.seconds !== "number")) return null;
    return {
      label: typeof reply.step === "string" ? reply.step : "",
      seconds: typeof reply.seconds === "number" ? reply.seconds : null,
      stepSeconds: typeof reply.stepSeconds === "number" ? reply.stepSeconds : null,
      number: typeof reply.stepNumber === "number" ? reply.stepNumber : null,
      total: typeof reply.stepTotal === "number" ? reply.stepTotal : null,
    };
  }
  function startingStatus() {
    if (startup && startup.label) {
      return "Automa is starting up: " + startup.label.charAt(0).toLowerCase() + startup.label.slice(1) + "…";
    }
    return "Automa is starting up. The first start after an update can take a minute…";
  }
  function tryOnce(address) {
    inFlight = true;
    connectOnce(address, null, function (reply) {
      inFlight = false;
      if (waitBox.hidden) return;
      if (reply && reply.ok !== false) {
        setStep("open", "Connected. " + nextStepText(reply));
        haptic("success");
        setPose("success");
        window.setTimeout(function () {
          stopWaiting();
          showConnected(reply);
        }, 450);
        return;
      }
      var message = (reply && reply.error) || "Could not connect.";
      var starting = !!(reply && reply.starting) || /still starting/i.test(message);
      // Nothing answered the first try: now Termux is asked to start Automa.
      if (startTermuxIfSilent && !startedTermux && !starting) {
        startTermuxIfSilent = false;
        startInTermux(function () { tryLater(address); });
        return;
      }
      if (starting) {
        // It answers: it is alive and working through its start. The page
        // keeps waiting, saying what Automa is doing and for how long.
        answered = true;
        silentTries = 0;
        silentSince = 0;
        askedRestart = false;
        startup = startupOf(reply);
        setStep("ready", startingStatus(), step !== "ready" && step !== "open");
        if (startup && startup.stepSeconds !== null && startup.stepSeconds >= STUCK_STEP_SECONDS) {
          setHelp("Automa has been on this step for " + duration(startup.stepSeconds) + ". If it doesn't move on, open Termux to see what it says; Ctrl+C there and then automa run starts it again.", true);
        } else if (silenceHelp || (startup && !waitHelp.hidden && /on this step/.test(waitHelp.textContent))) {
          setHelp("", false);
        }
        tryLater(address);
        return;
      }
      var silent = !!(reply && reply.silent) || /not running|nothing answers|try again|refused|closed the connection|did not answer/i.test(message);
      if (silent) {
        if (!silentSince) silentSince = Date.now();
        if (answered) {
          // It had answered and now does not: it stopped (Android closed
          // Termux, or Automa hit an error), which is not "still starting".
          silentTries += 1;
          if (silentTries >= SILENT_TRIES_BEFORE_HELP) {
            setStep("answer", "Automa stopped answering while it was starting up. Waiting for it to come back…", true);
            if (!silenceHelp) {
              setSilenceHelp("Android may have closed Termux, or Automa ran into an error. Open Termux to see what it says; automa run starts it again. Setting Termux's battery use to Unrestricted keeps it running.");
            }
            // `automa start` starts it only if it is not running: once per silence.
            if (!askedRestart && canAskTermuxQuietly()) {
              askedRestart = true;
              startInTermux(function () { tryLater(address); });
              return;
            }
          }
        } else {
          setStep("answer", startedTermux ? "Waiting for Automa to answer…" : "Waiting for Automa on this phone to answer…");
          if (Date.now() - waitStarted > 45000 && waitHelp.hidden) {
            setSilenceHelp("This is taking longer than usual. Android may have closed Termux: open it and run automa run. Setting Termux's battery use to Unrestricted keeps it running.");
          }
        }
        if (Date.now() - silentSince < GIVE_UP_SILENT_MS) {
          tryLater(address);
          return;
        }
        if (answered) {
          message = "Automa on this phone stopped answering while it was starting up, and has not come back in 5 minutes. Open Termux to see what it says, then run automa run there.";
        }
      }
      stopWaiting();
      setPose("confused");
      haptic("warning");
      showError(message);
      if (silent && isThisPhone(address)) openThisPhone();
    });
  }
  // Termux's automa run (or automa link) asked the app to connect while this
  // page is open: Termux is starting Automa, so the page waits for it (it used
  // to reload and start its steps over) and asks Termux for nothing.
  window.__automaConnectRequested = function (address) {
    var target = address || lastWaitAddress || input.value;
    if (!target) return;
    startTermuxIfSilent = false;
    if (waitBox.hidden) {
      connectWaiting(target, false);
      startedTermux = true;
      return;
    }
    startedTermux = true;
    if (!answered && (step === "termux" || step === "answer")) {
      setStep("answer", "Termux is starting Automa. Waiting for it to answer…");
    }
    // Asked now instead of at the next tick, unless a try is already on its way.
    if (!inFlight) connectWaiting(lastWaitAddress || target, false);
  };
  document.getElementById("wait-fix-copy").addEventListener("click", function () {
    haptic("tick");
    if (bridge && bridge.copyText) bridge.copyText(KEY, waitFixCommand.textContent || "");
    if (bridge && bridge.openTermux) bridge.openTermux(KEY);
  });
  document.getElementById("wait-fix-retry").addEventListener("click", function () {
    haptic("tick");
    if (!bridge) return;
    waitFix.hidden = true;
    if (waitBox.hidden) {
      connectWaiting(lastWaitAddress || input.value, true);
      return;
    }
    startInTermux(function () {}, true);
  });
  waitTermux.addEventListener("click", function () {
    haptic("tick");
    if (bridge && bridge.openTermux) bridge.openTermux(KEY);
  });
  document.getElementById("wait-stop").addEventListener("click", function () {
    haptic("tick");
    stopWaiting();
    setPose("listening");
  });
  function renderRequested(request) {
    requested.hidden = !request;
    if (!request) return;
    document.getElementById("requested-url").textContent = request.url.replace(/^https?:\/\//, "");
    // Any app can send this request; the app can't tell Termux from another.
    document.getElementById("requested-detail").textContent = request.withKey
      ? "It came with an app key, the way automa run and automa link in Termux send one. Tap Connect only if you just ran one of those; otherwise dismiss it."
      : "Tap Connect only if you expected this (for example, you just linked a computer over ADB); otherwise dismiss it.";
    input.value = request.url.replace(/^https?:\/\//, "");
    requested.scrollIntoView({ behavior: "smooth", block: "nearest" });
    // The server this phone already uses: no tap, the page waits for it and
    // opens Automa by itself (the timer below says when the next try is).
    if (request.autoStart) connectWaiting(request.url);
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
    // Automa on this phone is not answering (Termux closed, or still starting):
    // wait for it here with the timer, and open the board by itself.
    if (!state.requested && params.get("wait") === "1" && state.waitFor) {
      input.value = state.waitFor.replace(/^https?:\/\//, "");
      showError("");
      // Right after automa run / automa link asked to connect, Automa is
      // already starting in Termux: only wait for it.
      connectWaiting(state.waitFor, !state.startedByRequest);
    }
  }

  // First run: put the cursor in the address field so typing can start at
  // once. With saved servers, leave the keyboard down: one tap on a recent
  // server connects.
  if (!serverStep.hidden && recentSection.hidden && !input.value && requested.hidden) input.focus();
})();
