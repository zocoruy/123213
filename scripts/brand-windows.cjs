const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const ResEdit = require('resedit');

// electron-builder already uses resedit for Electron's ASAR-integrity resource.
// This hook applies branding without running rcedit through Wine on Linux.
module.exports = async function brandWindows(context) {
  if (context.electronPlatformName !== 'win32') return;

  const info = context.packager.appInfo;
  const executablePath = path.join(context.appOutDir, `${info.productFilename}.exe`);
  const iconPath = path.join(context.packager.projectDir, 'resources', 'icon.ico');
  const executable = ResEdit.NtExecutable.from(await fs.readFile(executablePath));
  const resource = ResEdit.NtExecutableResource.from(executable);
  // Preserve both the ASAR-integrity payload and Windows execution manifest.
  const preservedResources = entries => entries
    .filter(entry => entry.type === 'INTEGRITY' || entry.type === 24)
    .map(entry => ({
      type: entry.type, id: entry.id, lang: entry.lang, codepage: entry.codepage,
      bytes: Buffer.from(entry.bin).toString('base64'),
    }));
  const preserved = preservedResources(resource.entries);

  const icon = ResEdit.Data.IconFile.from(await fs.readFile(iconPath));
  const groups = ResEdit.Resource.IconGroupEntry.fromEntries(resource.entries);
  for (const group of groups.length ? groups : [{ id: 1, lang: 1033 }]) {
    ResEdit.Resource.IconGroupEntry.replaceIconsForResource(
      resource.entries, group.id, group.lang, icon.icons.map(item => item.data),
    );
  }
  const version = `${info.version.split('-')[0]}.0`;
  for (const entry of ResEdit.Resource.VersionInfo.fromEntries(resource.entries)) {
    for (const language of entry.getAllLanguagesForStringValues()) {
      entry.setFileVersion(version, language.lang);
      entry.setProductVersion(version, language.lang);
      entry.setStringValues(language, {
        ProductName: info.productName,
        FileDescription: info.productName,
        CompanyName: info.companyName || info.productName,
        InternalName: info.productFilename,
        OriginalFilename: `${info.productFilename}.exe`,
      });
    }
    entry.outputToResourceEntries(resource.entries);
  }

  resource.outputResource(executable);
  const output = Buffer.from(executable.generate());
  const emittedResources = ResEdit.NtExecutableResource.from(ResEdit.NtExecutable.from(output));
  assert.deepEqual(preservedResources(emittedResources.entries), preserved,
    'Windows branding must preserve Electron ASAR integrity and application manifest');
  const temporaryPath = `${executablePath}.branding`;
  await fs.writeFile(temporaryPath, output);
  await fs.rename(temporaryPath, executablePath);
  console.log(`  • applied SprintSelect icon and version resources; preserved ASAR integrity and manifest`);
};
