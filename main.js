const { app, BrowserWindow, screen, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { exec } = require('child_process');

let mainWindow;

function createWindow() {
    const { width, height } = screen.getPrimaryDisplay().workAreaSize;

    mainWindow = new BrowserWindow({
        width: width,
        height: height,
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: false,
            nodeIntegration: true
        },
        darkTheme: true,
        icon: path.join(__dirname, 'media', 'main_favicon.png')
    });

    mainWindow.loadFile(path.join(__dirname, 'index.html'));

    const appDataFolderPath = path.join(app.getPath('userData'), 'AppData');

    if (!fs.existsSync(appDataFolderPath)) {
        fs.mkdirSync(appDataFolderPath, { recursive: true });
        console.log('Folder "AppData" created successfully.');
    } else {
        console.log('Folder "AppData" already exists.');
    }

    const coursesFilePath = path.join(appDataFolderPath, 'courses.json');

    if (!fs.existsSync(coursesFilePath)) {
        fs.writeFileSync(coursesFilePath, JSON.stringify([], null, 2));
        console.log('File "courses.json" created successfully.');
    } else {
        console.log('File "courses.json" already exists.');
    }

    mainWindow.webContents.on('did-finish-load', () => {
        mainWindow.webContents.send('load-courses');
    });
}

ipcMain.handle('get-app-data-path', () => {
    return path.join(app.getPath('userData'), 'AppData');
});

ipcMain.handle('open-html-file', (event, filePath) => {
    const openCommand = process.platform === 'win32' ? `start "" "${filePath}"` :
                        process.platform === 'darwin' ? `open "${filePath}"` :
                        `xdg-open "${filePath}"`;
    exec(openCommand, (error) => {
        if (error) {
            console.error(`Error opening file: ${error.message}`);
        }
    });
});

ipcMain.handle('open-file-dialog', async (event, options) => {
    const result = await dialog.showOpenDialog(BrowserWindow.getFocusedWindow(), options);
    return result;
});

ipcMain.on('open-slide-viewer', async (event, { contentIdGlobal, currentCourseFolder, currentCourseId }) => {
    const mediaFilePath = path.join(currentCourseFolder, 'media.json');
    let slides = [];

    try {
        const mediaFileContent = await fs.promises.readFile(mediaFilePath, 'utf8');
        slides = JSON.parse(mediaFileContent);
    } catch (error) {
        console.error('Error reading media.json:', error);
    }

    const slideWindow = new BrowserWindow({
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: false,
            nodeIntegration: true
        }
    });

    slideWindow.loadFile('new-window.html');
    slideWindow.webContents.on('did-finish-load', () => {
        slideWindow.webContents.send('slides-data', slides);
    });
});

app.whenReady().then(() => {
    createWindow();

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});
