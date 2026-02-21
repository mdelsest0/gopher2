module.exports = {
    packagerConfig: {
      icon: 'media/app_icon'
    },
    makers: [
      {
        name: '@electron-forge/maker-squirrel',
        config: {
          name: 'gopher',
          authors: 'Michael Del Sesto',
          exe: 'gopher.exe',
          description: 'Your Electron App Description'
        }
      },
      {
        name: '@electron-forge/maker-zip',
        platforms: ['darwin']
      },
      {
        name: '@electron-forge/maker-deb',
        config: {}
      },
      {
        name: '@electron-forge/maker-rpm',
        config: {}
      }
    ]
  };
  