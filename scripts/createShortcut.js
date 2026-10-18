const fs = require('fs');
const { execSync } = require('child_process');
const path = require('path');

const targetBat = path.resolve(__dirname, '..', 'Launch_BTC_Compare.bat');
const workingDir = path.resolve(__dirname, '..');
const desktopLnk = 'C:\\Users\\Administrator\\Desktop\\BTC Compare Lab.lnk';

const vbsContent = [
  'Set oWS = WScript.CreateObject("WScript.Shell")',
  `sLinkFile = "${desktopLnk.replace(/\\/g, '\\\\')}"`,
  'Set oLink = oWS.CreateShortcut(sLinkFile)',
  `oLink.TargetPath = "${targetBat.replace(/\\/g, '\\\\')}"`,
  `oLink.WorkingDirectory = "${workingDir.replace(/\\/g, '\\\\')}"`,
  'oLink.Description = "1-Click Launch BTC Compare Lab (0.02 vs 0.06)"',
  'oLink.IconLocation = "shell32.dll,220"',
  'oLink.Save'
].join('\r\n');

const tempVbs = path.resolve(__dirname, 'temp_shortcut.vbs');
fs.writeFileSync(tempVbs, vbsContent);
try {
  execSync(`cscript //nologo "${tempVbs}"`);
  console.log('Desktop shortcut (.lnk) created successfully at:', desktopLnk);
} finally {
  if (fs.existsSync(tempVbs)) fs.unlinkSync(tempVbs);
}
