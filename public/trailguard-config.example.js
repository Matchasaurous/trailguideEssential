// Trailguard Essentials — site configuration
// ------------------------------------------------------------------
// On the web server, RENAME this file to  trailguard-config.js  and fill it in.
// (Hostinger: hPanel → Websites → Manage → File Manager → public_html.)
// Changes take effect when phones next open the app — no rebuild needed.
// Website updates never include trailguard-config.js, so your settings survive.
//
// Everything here is public: every browser downloads it. That is normal for
// Firebase web config. Access is enforced by your database rules
// (database.rules.json) and by the Apps Script token check.
//
// Any value left empty falls back to the app's built-in .env value (if any).

window.TRAILGUARD_CONFIG = {
  // Firebase console → ⚙ Project settings → General → Your apps → Web app →
  // "SDK setup and configuration" → Config. Copy the matching values.
  firebase: {
    apiKey: '',
    authDomain: '',            // e.g. 'your-project.firebaseapp.com'
    databaseURL: '',           // e.g. 'https://your-project-default-rtdb.asia-southeast1.firebasedatabase.app'
    projectId: '',             // e.g. 'your-project'
    appId: ''                  // e.g. '1:1234567890:web:abc123'
  },

  // Apps Script web app URL (Deploy → Manage deployments → Web app URL, ends in /exec).
  // Used for Drive archiving: bodycam clips, photos, patient records, reports.
  gasEndpoint: '',

  // Address of this site: invite links shared from the Android app point here.
  publicUrl: 'https://app.trailguardessentials.com/',

  // "Continue with Google" on the sign-in screen (website only; the Android app keeps
  // email and password). Needs Google switched on in Firebase → Authentication →
  // Sign-in method, and this site under Authentication → Settings → Authorized domains.
  googleSignIn: true,

  // Number shown on SOS screens (Singapore SCDF: 995).
  emergencyNumber: '995',

  // WebRTC servers for push-to-talk and live video. STUN works on most Wi-Fi;
  // phones on mobile data often also need a TURN relay, e.g.
  // [
  //   { urls: ['stun:stun.l.google.com:19302'] },
  //   { urls: ['turn:turn.example.com:3478?transport=udp', 'turns:turn.example.com:5349'], username: 'user', credential: 'pass' }
  // ]
  // null = the built-in default (Google public STUN).
  iceServers: null
};
