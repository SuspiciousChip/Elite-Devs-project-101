// IMPORTANT: chrome.desktopCapture.chooseDesktopMedia(sources, targetTab, cb)
// scopes the returned streamId to the EXACT tab passed as targetTab — per
// Chrome's docs, the stream "can only be used by frames in the given tab
// whose security origin matches tab.url." If we pass the tab that was
// active when the icon was clicked, then try to consume the streamId in a
// *different*, newly-created tab, getUserMedia() throws a DOMException
// ("Invalid state") in that new tab every time. That was the actual bug —
// not a timing/expiry issue.
//
// Fix: create the ThinkSync tab FIRST, target THAT tab in
// chooseDesktopMedia, and hand the streamId to the page via runtime
// messaging (not the URL) once the page has loaded and is listening. This
// also sidesteps the streamId's few-seconds expiry, since it isn't
// generated until the page already exists and is ready to consume it.
chrome.action.onClicked.addListener(() => {
  const thinkSyncUrl = chrome.runtime.getURL("thinksync.html?autocapture=1");

  chrome.tabs.create({ url: thinkSyncUrl }, (newTab) => {
    if (chrome.runtime.lastError || !newTab) {
      console.error(
        "ThinkSync: failed to open ThinkSync tab.",
        chrome.runtime.lastError
      );
      return;
    }

    const sendStreamId = (streamId) => {
      chrome.tabs.sendMessage(newTab.id, {
        type: "thinksync-stream-id",
        streamId: streamId || null,
      });
    };

    const onReady = (message, sender) => {
      if (
        !message ||
        message.type !== "thinksync-ready-for-capture" ||
        !sender.tab ||
        sender.tab.id !== newTab.id
      ) {
        return; // not the handshake we're waiting for
      }
      chrome.runtime.onMessage.removeListener(onReady);

      // chrome.desktopCapture.chooseDesktopMedia shows the native
      // "Chrome Tab / Window / Entire Screen" picker (its exact appearance
      // is controlled by Chrome/the OS, not by us). The first time a given
      // OS also requires a one-time OS-level screen-recording permission
      // (e.g. macOS), that's handled by the OS itself, outside our code.
      if (!chrome.desktopCapture || !chrome.desktopCapture.chooseDesktopMedia) {
        // This means the "desktopCapture" permission in manifest.json isn't
        // actually active for this loaded copy of the extension — almost
        // always because Chrome needs a full reload after a manifest
        // change. Go to chrome://extensions, remove this extension, and
        // "Load unpacked" again (a simple refresh-icon click sometimes
        // isn't enough to pick up a new permission).
        console.error(
          "ThinkSync: chrome.desktopCapture is unavailable — reload the unpacked extension from chrome://extensions after a manifest.json change."
        );
        sendStreamId(null);
        return;
      }

      chrome.desktopCapture.chooseDesktopMedia(
        ["screen", "window", "tab"],
        sender.tab, // fresh tab object as of right now, not the stale
                    // snapshot from chrome.tabs.create — its .url must be
                    // fully resolved to thinksync.html for chooseDesktopMedia
                    // to scope the streamId to this tab correctly.
        (streamId) => {
          if (!streamId) {
            console.warn("ThinkSync: capture picker was cancelled or denied.");
          }
          sendStreamId(streamId);
        }
      );
    };

    chrome.runtime.onMessage.addListener(onReady);
  });
});