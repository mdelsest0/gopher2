const { ipcRenderer } = require('electron');
const fs = require('fs').promises;
const path = require('path');
const { Chart, registerables } = require('chart.js');
const os = require('os');

// for content downloading
const { PDFDocument } = require('pdf-lib');
const { exec } = require('child_process');
const pdfPoppler = require('pdf-poppler');
const pptx2pdf = require('pptx2pdf');
const convert = require('libreoffice-convert');
const officegen = require('officegen');
const pdf = require('pdf-poppler');
const pdf2pic = require('pdf2pic');

// for Gemini
const { GoogleGenerativeAI } = require("@google/generative-ai");

// for chart
Chart.register(...registerables);

let currentCourseId = null; // Variable to store the current course ID
let showingHiddenCourses = false; // Track if hidden courses are currently being shown
let courses = null; // global variable for the json course data
let currentCourseFolder = null; // Initialize properly later
let contentIdGlobal = null;

// for calendar
const appDataPath = null;
const calURLFilePath = null;

// functions for downloading
async function uploadMedia(contentId) {
    const uploadMediaButton = document.getElementById('upload-media-button');
    uploadMediaButton.classList.add('generate-questions-running'); // Change button color at the start

    const contentDetails = await getContentById(contentId);
    const mediaStoragePath = path.join(contentDetails.folderLink, 'mediaStorage');
    const mediaFilePath = path.join(contentDetails.folderLink, 'media.json');

    let mediaExists = false;
    try {
        const mediaFiles = await fs.readdir(mediaStoragePath);
        if (mediaFiles.length > 0) {
            mediaExists = true;
        }
    } catch (error) {
        if (error.code !== 'ENOENT') {
            console.error('Error accessing mediaStorage folder:', error);
            uploadMediaButton.classList.remove('generate-questions-running');
            return;
        }
    }

    if (mediaExists) {
        if (confirm('Media already exists. Do you want to rewrite the media?')) {
            try {
                // Remove all files in mediaStorage folder
                const mediaFiles = await fs.readdir(mediaStoragePath);
                for (const file of mediaFiles) {
                    await fs.unlink(path.join(mediaStoragePath, file));
                }
                // Remove media.json
                await fs.unlink(mediaFilePath);
            } catch (error) {
                console.error('Error clearing existing media:', error);
                uploadMediaButton.classList.remove('generate-questions-running');
                return;
            }
        } else {
            console.log('User chose not to overwrite existing media.');
            uploadMediaButton.classList.remove('generate-questions-running');
            return;
        }
    }

    const { filePaths } = await ipcRenderer.invoke('open-file-dialog', {
        properties: ['openFile'],
        filters: [
            { name: 'Presentations', extensions: ['pdf'] }
        ]
    });

    if (filePaths.length === 0) {
        console.log('No file selected');
        uploadMediaButton.classList.remove('generate-questions-running');
        return;
    }

    const filePath = filePaths[0];
    const ext = path.extname(filePath).toLowerCase();

    if (ext === '.pdf') {
        await convertPdfToImages(filePath, contentId);
    } else {
        console.log('Unsupported file type');
    }

    uploadMediaButton.classList.remove('generate-questions-running'); // Revert button color at the end
}



// Functions for API
// Function to generate questions using the Gemini API
async function generateQuestions(apiKey) {
    const generateQuestionsButton = document.getElementById('generate-questions-button');
    generateQuestionsButton.classList.add('generate-questions-running'); // Change button color at the start

    const contentDetails = await getContentById(contentIdGlobal);
    const mediaStoragePath = path.join(contentDetails.folderLink, 'mediaStorage');
    
    let mediaStorageExists = false;
    try {
        await fs.access(mediaStoragePath);
        mediaStorageExists = true;
    } catch (error) {
        if (error.code === 'ENOENT') {
            console.error('mediaStorage folder does not exist.');
            return;
        } else {
            throw error;
        }
    }

    if (mediaStorageExists) {
        const files = (await fs.readdir(mediaStoragePath)).filter(file => file.endsWith('.jpeg') || file.endsWith('.jpg'));

        if (files.length === 0) {
            console.error('No JPEG files found in the mediaStorage folder.');
            console.log(mediaStoragePath)
            return;
        }

         // Clear existing questions.json if it exists
         try {
            await fs.writeFile(questionsFilePath, JSON.stringify([]));
            console.log('Cleared existing questions.json file.');
        } catch (error) {
            console.error('Error clearing questions.json:', error);
        }

        const genAI = new GoogleGenerativeAI(apiKey);
        const questions = [];

        for (const file of files) {
            const filePath = path.join(mediaStoragePath, file);
            console.log(filePath)
            const imagePart = await fileToGenerativePart(filePath, 'image/jpeg');
            const prompt = 'If and only if this is not a filler slide (title slide, transition slide, etc) then generate a summary of the slide in a section labeled "Summary:". If and only if PhD level or MD level vocabulary exist, generate a list of vocabulary under "Vocabulary:". Define each vocabulary word you include. If and only if this is not a filler slide (title slide, transition slide, etc), generate difficult PhD-level questions based on the content of this slide under "Questions:". List the questions, each on a new line, without any character up front. There is no minimum or maximum number of questions you can generate. Only ask questions on material that would show up on a quiz or a test; if no such material on the slide, then do not include any questions. Do not refrence this prompt in your response, simply give the content requested in the format requested.';

            try {
                const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
                console.log(imagePart)
                const result = await model.generateContent([prompt, imagePart]);
                const response = await result.response;
                const text = response.text();

                questions.push({
                    questionPrompt: text,
                    questionAnswer: '', // You can customize this based on the API response if available
                    slideFilePath: filePath,
                    uploadDate: new Date().toLocaleString()
                });
            } catch (error) {
                console.error(`Error generating questions for ${file}:`, error);
            }
        }

        const questionsFilePath = path.join(contentDetails.folderLink, 'questions.json');
        await fs.writeFile(questionsFilePath, JSON.stringify(questions, null, 2));
        console.log('Questions generated and saved successfully.');
    }

    generateQuestionsButton.classList.remove('generate-questions-running'); // Revert button color at the end
}

// Converts local file information to a GoogleGenerativeAI.Part object asynchronously
async function fileToGenerativePart(filePath, mimeType) {
    const data = await fs.readFile(filePath);
    return {
        inlineData: {
            data: data.toString('base64'),
            mimeType
        },
    };
}


// Function to generate HTML page with questions
async function generateHtmlPageWithQuestions() {
    const generateStudyPageButton = document.getElementById('generate-study-page-button');
    generateStudyPageButton.classList.add('generate-questions-running'); // Change button color at the start

    const contentDetails = await getContentById(contentIdGlobal);
    const questionsFilePath = path.join(contentDetails.folderLink, 'questions.json');
    
    let questions = [];
    let aiAssist = confirm("Do you want to print with AI Assist?");
    let questionsExist = false;

    if (aiAssist) {
        try {
            const questionsFileContent = await fs.readFile(questionsFilePath, 'utf8');
            questions = JSON.parse(questionsFileContent);
            questionsExist = true;
        } catch (error) {
            if (error.code === 'ENOENT') {
                console.log('questions.json file does not exist.');
            } else {
                console.error('Error reading questions.json:', error);
                return;
            }
        }
    }

    let htmlContent = `
        <!DOCTYPE html>
        <html>
        <head>
            <title>${contentDetails.name}</title>
            <style>
                body {
                    font-family: Arial, sans-serif;
                    margin: 20px;
                }
                .slide {
                    margin-bottom: 40px;
                }
                img {
                    max-width: 100%;
                    height: auto;
                }
                h2 {
                    margin-top: 20px;
                }
                p {
                    white-space: pre-line;
                }
                .bold {
                    font-weight: bold;
                }
                .question {
                    color: black;
                    font-weight: bold;
                }
                .answer {
                    color: grey;
                    font-weight: normal;
                }
            </style>
        </head>
        <body>
            
    `;

    if (questionsExist) {
        for (const question of questions) {
            const slidePath = question.slideFilePath;
            const slideName = path.basename(slidePath);
            let questionPrompt = question.questionPrompt;

            // Extract and format sections
            let formattedPrompt = '';
            const sections = ['Summary', 'Vocabulary', 'Questions'];
            let questionsList = [];

            sections.forEach(section => {
                const regex = new RegExp(`(${section}:)\\s*([\\s\\S]*?)(?=(Summary:|Vocabulary:|Questions:|$))`, 'gi');
                const match = regex.exec(questionPrompt);
                if (match && section !== 'Questions') {
                    formattedPrompt += `<span class="bold">${match[1]}</span><br>${match[2].replace(/\n/g, '<br>')}<br><br>`;
                } else if (match && section === 'Questions') {
                    questionsList = match[2].split('\n').filter(q => q.trim() !== '');
                }
            });

            htmlContent += `
                <div class="slide">
                    
                    <img src="file://${slidePath}" alt="${slideName}">
                    <p>${formattedPrompt}</p>
                    <div class="questions">
            `;

            questionsList.forEach(q => {
                htmlContent += `<p><span class="question">Q: ${q.trim()}</span><br><span class="answer">-</span><br><br></p>`;
            });

            htmlContent += `
                    </div>
                </div>

                <p style="page-break-after: always;">&nbsp;</p>
                <p style="page-break-before: always;">&nbsp;</p>
            `;
        }
    } else {
        const mediaStoragePath = path.join(contentDetails.folderLink, 'mediaStorage');
        const files = await fs.readdir(mediaStoragePath);
        const imageFiles = files.filter(file => file.endsWith('.jpeg') || file.endsWith('.jpg'));

        for (const file of imageFiles) {
            const slidePath = path.join(mediaStoragePath, file);
            const slideName = path.basename(slidePath);
            htmlContent += `
                <div class="slide">
                    
                    <img src="file://${slidePath}" alt="${slideName}">
                    <h2> </h2>
                </div>
            `;
        }
    }

    htmlContent += `
        </body>
        </html>
    `;

    const outputFilePath = path.join(contentDetails.folderLink, `${contentDetails.name}_questions.html`);
    try {
        await fs.writeFile(outputFilePath, htmlContent, 'utf8');
        console.log(`HTML page generated and saved successfully at ${outputFilePath}.`);

        // Send a message to the main process to open the generated HTML file
        await ipcRenderer.invoke('open-html-file', outputFilePath);
    } catch (error) {
        console.error('Error writing HTML file:', error);
    }

    generateStudyPageButton.classList.remove('generate-questions-running'); // Revert button color at the end
}

// Function to generate HTML page with slides
async function generateHtmlPageWithNotes() {
    const generateStudyPageButton = document.getElementById('generate-study-page-button');
    generateStudyPageButton.classList.add('generate-questions-running'); // Change button color at the start

    const contentDetails = await getContentById(contentIdGlobal);
    const mediaFilePath = path.join(contentDetails.folderLink, 'media.json');
    
    let media = [];
    let includeNotes = confirm("Do you want to include notes?");
    
    try {
        const mediaFileContent = await fs.readFile(mediaFilePath, 'utf8');
        media = JSON.parse(mediaFileContent);
    } catch (error) {
        console.error('Error reading media.json:', error);
        return;
    }

    let htmlContent = `
        <!DOCTYPE html>
        <html>
        <head>
            <style>
                body {
                    font-family: Arial, sans-serif;
                    margin: 20px;
                }
                .slide {
                    margin-bottom: 40px;
                }
                img {
                    max-width: 100%;
                    height: auto;
                }
                h2 {
                    margin-top: 20px;
                }
                p {
                    white-space: pre-line;
                }
                .bold {
                    font-weight: bold;
                }
                .notes {
                    margin-top: 10px;
                    padding-left: 20px;
                }
                .note-item {
                    display: list-item;
                    list-style-type: disc;
                    margin-left: 20px;
                    font-size: 1.1em; /* Slightly larger font size for notes */
                }
            </style>
        </head>
        <body>
    `;

    for (const slide of media) {
        const slidePath = slide.filePath.replace(/%20/g, ' ');
        const slideName = path.basename(slidePath);

        htmlContent += `
            <div class="slide">
                <h2>Slide ${slide.slideNumber}</h2>
            `;

        if (includeNotes && slide.notes) {
            const notesList = slide.notes
    .split('\n')
    .filter(note => note.trim() !== '')  // Filter out empty lines
    .map(note => `<span class="note-item">${note}</span>`)
    .join('<br>');
            htmlContent += `
                <div class="notes">
                    ${notesList}
                </div>
            `;
        }

        htmlContent += `
        
            <p style="page-break-after: always;">&nbsp;</p>
            <p style="page-break-before: always;">&nbsp;</p>
            <img src="file://${slidePath}" alt="${slideName}">
        `;

        htmlContent += `
            </div>
            <p style="page-break-after: always;">&nbsp;</p>
                <p style="page-break-before: always;">&nbsp;</p>
        `;
    }

    htmlContent += `
        </body>
        </html>
    `;

    const outputFilePath = path.join(contentDetails.folderLink, `${contentDetails.name}_slides.html`);
    try {
        await fs.writeFile(outputFilePath, htmlContent, 'utf8');
        console.log(`HTML page generated and saved successfully at ${outputFilePath}.`);

        // Send a message to the main process to open the generated HTML file
        await ipcRenderer.invoke('open-html-file', outputFilePath);
    } catch (error) {
        console.error('Error writing HTML file:', error);
    }

    generateStudyPageButton.classList.remove('generate-questions-running'); // Revert button color at the end
}


// Function to make Anki cards
async function generateAnkiCards() {
    const generateAnkiCardsButton = document.getElementById('generate-anki-button');
    generateAnkiCardsButton.classList.add('generate-questions-running'); // Change button color at the start

    const contentDetails = await getContentById(contentIdGlobal);
    const mediaFilePath = path.join(contentDetails.folderLink, 'media.json');
    
    let media = [];
    try {
        const mediaFileContent = await fs.readFile(mediaFilePath, 'utf8');
        media = JSON.parse(mediaFileContent);
    } catch (error) {
        console.error('Error reading media.json:', error);
        generateAnkiCardsButton.classList.remove('generate-questions-running');
        return;
    }

    const tags = `tags:${contentDetails.name.replace(/\s+/g, '')}\n\n`;

    let txtContent = tags;
    const ankiMediaFolder = path.join(process.env.APPDATA, 'Anki2', 'User 1', 'collection.media');

    media.forEach(slide => {
        if (slide.questions) {
            const questionsList = slide.questions.split('\n').filter(q => q.trim() !== '');
            const notesList = slide.notes
                ? slide.notes.split('\n').filter(note => note.trim() !== '').map(note => `<br>• ${note}`).join('')
                : '';
            const imageName = path.basename(slide.filePath);

            // Copy image to Anki media folder
            const destinationPath = path.join(ankiMediaFolder, imageName);
            fs.copyFile(slide.filePath, destinationPath).catch(error => {
                console.error(`Error copying image ${imageName} to Anki media folder:`, error);
            });

            questionsList.forEach(question => {
                txtContent += `${question.trim()} ; <img src="${imageName}"> ${notesList ? `${notesList}` : ''} \n`;
            });
        }
    });

    const downloadsFolder = path.join(os.homedir(), 'Downloads');
    const outputFilePath = path.join(downloadsFolder, `${contentDetails.name}_questions_and_notes.txt`);
    try {
        await fs.writeFile(outputFilePath, txtContent.trim(), 'utf8');
        console.log(`TXT file generated and saved successfully at ${outputFilePath}.`);
    } catch (error) {
        console.error('Error writing TXT file:', error);
    }

    generateAnkiCardsButton.classList.remove('generate-questions-running'); // Change button color at the end
}


async function convertPdfToImages(pdfFilePath, contentId) {
    const content = await getContentById(contentId);
    const mediaStoragePath = path.join(content.folderLink, 'mediaStorage');
    const mediaFilePath = path.join(content.folderLink, 'media.json');
    
    let media = [];

    try {
        const mediaFileContent = await fs.readFile(mediaFilePath, 'utf8');
        media = JSON.parse(mediaFileContent);
    } catch (error) {
        console.log('No existing media.json file found. Creating a new one.');
    }

    const options = {
        format: 'jpeg',
        out_dir: mediaStoragePath,
        out_prefix: path.basename(pdfFilePath, path.extname(pdfFilePath)),
        page: null
    };

    try {
        const info = await pdf.info(pdfFilePath);
        for (let i = 1; i <= info.pages; i++) {
            options.page = i;
            await pdf.convert(pdfFilePath, options);

            // Ensure consistent non zero-padded numbering for file names
            let filePath = path.join(mediaStoragePath, `${options.out_prefix}-${i}.jpg`);
            try {
                await fs.access(filePath);
            } catch {
                filePath = path.join(mediaStoragePath, `${options.out_prefix}-${i.toString().padStart(2, '0')}.jpg`);
                try {
                    await fs.access(filePath);
                } catch {
                    console.error(`File not found for page ${i}: ${filePath}`);
                    continue;
                }
            }

            const mediaEntry = {
                filePath,
                slideNumber: i,
                uploadDate: new Date().toLocaleString(),
                slideId: generateRandomId()
            };

            media.push(mediaEntry);
        }

        await fs.writeFile(mediaFilePath, JSON.stringify(media, null, 2));
        console.log('Media successfully uploaded and converted.');
    } catch (error) {
        console.error('Error converting PDF to images:', error);
    }
}
  

async function getAppDataPath() {
    return await ipcRenderer.invoke('get-app-data-path');
  }

// Function to generate a random 10-digit number
function generateRandomId() {
    return Math.floor(Math.random() * 10000000000);
}

// Function to remove spaces from a string
function removeSpaces(str) {
    return str.replace(/\s+/g, '');
}

// function to handle pre-set study days
function preSelectStudyDays(days) {
    const today = new Date();
    selectedDates = [];
    days.forEach(day => {
        const date = new Date(today);
        // console.log(date)
        date.setDate(today.getDate() - day ); // subtract one day since using ISO
        // console.log(date)
        const dateString = date.toLocaleDateString().split(',')[0];
        // console.log(dateString)
        if (!selectedDates.includes(dateString )) {
            selectedDates.unshift(dateString);
        }
    });
    updateSelectedDatesUI();
}

function updateSelectedDatesUI() {
    const selectedDatesContainer = document.getElementById('selected-dates');
    selectedDatesContainer.innerHTML = '';
    selectedDates.forEach(date => {
        const dateItem = document.createElement('div');
        dateItem.classList.add('date-item');
        dateItem.textContent = date;

        const removeBtn = document.createElement('span');
        removeBtn.textContent = 'X';
        removeBtn.addEventListener('click', () => {
            selectedDates = selectedDates.filter(d => d !== date);
            updateSelectedDatesUI();
            updateContentGrids();
        });

        dateItem.appendChild(removeBtn);
        selectedDatesContainer.insertBefore(dateItem, selectedDatesContainer.firstChild); // Insert at the beginning
    });
    updateContentGrids(); // Call to update the grids after updating the UI
}

// New function to clear and repopulate content grids
async function updateContentGrids() {
    const contentGridContainer = document.getElementById('content-grid-container');
    contentGridContainer.innerHTML = ''; // Clear existing content grids

    const days = selectedDates.map(date => {
        const today = new Date();
        today.setHours(0, 0, 0, 0);  // Zero out the time part of today's date
    
        const selectedDate = new Date(date);
        selectedDate.setHours(0, 0, 0, 0);  // Zero out the time part of the selected date
    
        return Math.floor(( selectedDate-today) / (1000 * 60 * 60 * 24)); //+86400000 // HOT SPOT
    });

    await populateContentGrids(days);
    await populateAllContentGrid();
}

async function populateContentGrids(days) {
    const contentGridContainer = document.getElementById('content-grid-container');
    const contentFilePath = path.join(currentCourseFolder, 'lectures.json');
    let lectures = [];

    try {
        const lecturesFileContent = await fs.readFile(contentFilePath, 'utf8');
        lectures = JSON.parse(lecturesFileContent);
    } catch (error) {
        console.log('No existing lectures.json file found.');
    }

    // Clear any previous content grids before appending
    contentGridContainer.innerHTML = '';

    
    days.forEach(dayOffset => {
        const today = new Date();
        today.setDate(today.getDate() + dayOffset);
        const dateString = today.toLocaleDateString().split(',')[0];
        //console.log(dateString)
        //console.log(lectures)
        const dateHeader = document.createElement('div');
        dateHeader.classList.add('date-header');
        dateHeader.textContent = `${today.toDateString()}`;

        const contentGrid = document.createElement('div');
        contentGrid.classList.add('content-grid');

        lectures.forEach(lecture => {
            if (lecture.date === dateString) {
                const contentBox = createContentBox(lecture);
                contentGrid.appendChild(contentBox);
            }
        });

        contentGridContainer.appendChild(dateHeader);
        contentGridContainer.appendChild(contentGrid);
    });
}

async function populateAllContentGrid() {
    const contentGridContainer = document.getElementById('content-grid-container');
    const allHeader = document.createElement('div');
    allHeader.classList.add('date-header');
    allHeader.textContent = 'All';

    const contentGrid = document.createElement('div');
    contentGrid.classList.add('content-grid');

    const contentFilePath = path.join(currentCourseFolder, 'lectures.json');
    let lectures = [];

    try {
        const lecturesFileContent = await fs.readFile(contentFilePath, 'utf8');
        lectures = JSON.parse(lecturesFileContent);
    } catch (error) {
        console.log('No existing lectures.json file found.');
    }

    lectures.forEach(lecture => {
        const contentBox = createContentBox(lecture);
        contentGrid.appendChild(contentBox);
    });

    // Clear any previous "All" header and grid before appending
    const allContentSection = document.getElementById('all-content-section');
    if (allContentSection) {
        allContentSection.remove();
    }

    const allContentSectionDiv = document.createElement('div');
    allContentSectionDiv.id = 'all-content-section';
    allContentSectionDiv.appendChild(allHeader);
    allContentSectionDiv.appendChild(contentGrid);

    contentGridContainer.appendChild(allContentSectionDiv);
}

function formatDateWithoutYear(dateString) {
    // Handle different date formats
    const dateParts = dateString.split(/[-/]/); // Split by hyphen or slash
    const myYear = dateParts[dateParts.length - 1];
    const myDay = Number(dateParts[dateParts.length - 2]);
    const myMonth = Number(dateParts[dateParts.length - 3]);
  
    // Create a Date object
    //const date = new Date(myYear, myMonth - 1, myDay); // Month is 0-indexed
    const date = new Date();

    // Set the year
    date.setFullYear(myYear);

    // Set the month (remembering that months are 0-indexed, so July is 6)
    date.setMonth(myMonth-1);

    // Set the day
    date.setDate(myDay);
  
    // Format the date without the year
    const options = { month: 'short', day: 'numeric' };
    return date.toLocaleDateString(undefined, options);
    console.log("TRANS")
    console.log(date)
  }

// Function to create content box
function createContentBox(content) {
    const contentBox = document.createElement('div');
    contentBox.classList.add('content-box');
    contentBox.addEventListener('click', () => populateContentDetails(content.id)); // Add click event to populate content details

    const contentName = document.createElement('div');
    contentName.classList.add('content-name');
    contentName.textContent = content.name;

    const daysStudied = document.createElement('div');
    daysStudied.classList.add('days-studied');
    daysStudied.textContent = content.daysStudied ? content.daysStudied.reverse().map(formatDateWithoutYear).join(', ') : '';

    contentBox.appendChild(contentName);
    contentBox.appendChild(daysStudied);

    return contentBox;
}

// for slide viewer
let currentSlideIndex = 0;
let slides = [];

async function openSlideViewer() {
    const contentDetails = await getContentById(contentIdGlobal);
    const mediaFilePath = path.join(contentDetails.folderLink, 'media.json');
    let slides = [];

    try {
        const mediaFileContent = await fs.readFile(mediaFilePath, 'utf8');
        slides = JSON.parse(mediaFileContent);
    } catch (error) {
        console.error('Error reading media.json:', error);
    }

    let currentSlideIndex = 0;
    let currentSlideId = slides[currentSlideIndex].slideId;

    // Hide the nav-panel and main-content
    document.getElementById('nav-panel').classList.add('hidden');
    document.getElementById('main-content').classList.add('hidden');

    // Create slide viewer container
    const slideViewerContainer = document.createElement('div');
    slideViewerContainer.id = 'slide-viewer-container';
    document.body.appendChild(slideViewerContainer);

    // Create Back button
    const backButton = document.createElement('button');
    backButton.textContent = 'Back';
    backButton.id = 'back-button';
    backButton.addEventListener('click', async () => {
        await saveCurrentSlideData(); // Save current slide data before leaving
        document.getElementById('nav-panel').classList.remove('hidden');
        document.getElementById('main-content').classList.remove('hidden');
        document.body.removeChild(slideViewerContainer);
    });
    slideViewerContainer.appendChild(backButton);

    // Create left side container for slides
    const leftSideContainer = document.createElement('div');
    leftSideContainer.id = 'left-side-container';
    slideViewerContainer.appendChild(leftSideContainer);

    // Create right side container for questions and notes
    const rightSideContainer = document.createElement('div');
    rightSideContainer.id = 'right-side-container';
    slideViewerContainer.appendChild(rightSideContainer);

    // Create slide image element
    const slideImage = document.createElement('img');
    slideImage.id = 'slide-image';
    leftSideContainer.appendChild(slideImage);

    // Create question input
    const questionInput = document.createElement('textarea');
    questionInput.id = 'question-input';
    questionInput.placeholder = 'Enter questions here...';
    rightSideContainer.appendChild(questionInput);

    // Create notes input
    const notesInput = document.createElement('textarea');
    notesInput.id = 'notes-input';
    notesInput.placeholder = 'Enter notes here...';
    rightSideContainer.appendChild(notesInput);

    // Create navigation buttons
    const navButtonsContainer = document.createElement('div');
    navButtonsContainer.id = 'nav-buttons-container';
    leftSideContainer.appendChild(navButtonsContainer);

    const prevButton = document.createElement('button');
    prevButton.textContent = 'Previous';
    prevButton.id = 'prev-button';
    prevButton.addEventListener('click', () => navigateSlide(-1));
    navButtonsContainer.appendChild(prevButton);

    const nextButton = document.createElement('button');
    nextButton.textContent = 'Next';
    nextButton.id = 'next-button';
    nextButton.addEventListener('click', () => navigateSlide(1));
    navButtonsContainer.appendChild(nextButton);

    async function navigateSlide(direction) {
        await saveCurrentSlideData(); // Save current slide data before navigating
        currentSlideIndex += direction;
        if (currentSlideIndex < 0) {
            currentSlideIndex = 0;
        } else if (currentSlideIndex >= slides.length) {
            currentSlideIndex = slides.length - 1;
        }
        currentSlideId = slides[currentSlideIndex].slideId;
        updateSlideView();
    }

    function updateSlideView() {
        const currentSlide = slides[currentSlideIndex];
        slideImage.src = currentSlide.filePath.replace(/%20/g, ' ');
        questionInput.value = currentSlide.questions || '';
        notesInput.value = currentSlide.notes || '';
    }

    async function saveCurrentSlideData() {
        const currentSlide = slides[currentSlideIndex];
        currentSlide.questions = questionInput.value;
        currentSlide.notes = notesInput.value;

        try {
            await fs.writeFile(mediaFilePath, JSON.stringify(slides, null, 2));
            console.log('Slide data saved successfully.');
        } catch (error) {
            console.error('Error saving slide data:', error);
        }
    }

    // Initialize with the first slide
    if (slides.length > 0) {
        updateSlideView();
    }

    function handleKeyDown(event) {
        if (event.key === 'ArrowLeft') {
            navigateSlide(-1);
        } else if (event.key === 'ArrowRight') {
            navigateSlide(1);
        } else if (event.key === 'ArrowUp') {
            questionInput.focus();
            setCursorToEnd(questionInput);
        } else if (event.key === 'ArrowDown') {
            notesInput.focus();
            setCursorToEnd(notesInput);
        }
    }

    function setCursorToEnd(input) {
        const length = input.value.length;
        input.setSelectionRange(length, length);
    }

    document.addEventListener('keydown', handleKeyDown);

    // Save slide data when the input fields are changed
    questionInput.addEventListener('input', saveCurrentSlideData);
    notesInput.addEventListener('input', saveCurrentSlideData);
}



function displaySlide(index) {
    const slideImage = document.getElementById('slide-image');
    console.log(slides[index].filePath)
    console.log(slides[index].filePath.replace(/%20/g, ' '))
    slideImage.src = slides[index].filePath.replace(/%20/g, ' ');
}

async function populateContentDetails(contentId) {
    contentIdGlobal = contentId;
    const contentDetails = await getContentById(contentId);
    const contentDetailsContainer = document.getElementById('content-details');

    contentDetailsContainer.innerHTML = ''; // Clear previous content details

    if (contentDetails) {
        const contentNameInput = document.createElement('input');
        contentNameInput.type = 'text';
        contentNameInput.value = contentDetails.name;
        contentNameInput.classList.add('content-name-input');

        const daysStudiedContainer = document.createElement('div');
        daysStudiedContainer.classList.add('days-studied-container');
        daysStudiedContainer.id = 'days-studied-container';
        updateDaysStudiedUI(contentDetails.daysStudied, daysStudiedContainer);

        contentDetailsContainer.appendChild(contentNameInput);
        contentDetailsContainer.appendChild(daysStudiedContainer);

        const deleteButton = document.createElement('button');
        deleteButton.textContent = 'Delete';
        deleteButton.classList.add('delete-button');
        deleteButton.addEventListener('click', async () => {
            if (confirm('Are you sure you want to delete this content?')) {
                await deleteContent(contentId, contentDetails.name);
                contentDetailsContainer.classList.add('hidden');
                updateContentGrids();
            }
        });
        contentDetailsContainer.appendChild(deleteButton);

        const uploadMediaButton = document.createElement('button');
        uploadMediaButton.textContent = 'Upload Media';
        uploadMediaButton.classList.add('upload-media-button');
        uploadMediaButton.id = 'upload-media-button';
        uploadMediaButton.addEventListener('click', () => uploadMedia(contentId));

        contentDetailsContainer.appendChild(uploadMediaButton);

        // create the generate questions Gemini button
        const generateQuestionsButton = document.createElement('button');
        generateQuestionsButton.textContent = 'AI Questions';
        generateQuestionsButton.id = 'generate-questions-button';
        generateQuestionsButton.classList.add('generate-questions');
        generateQuestionsButton.addEventListener('click', async () => {
            const appDataPath = await getAppDataPath();
            const geminiApiKeyFilePath = path.join(appDataPath, 'GeminiApiKey.txt');
        

            // Check if the GeminiApiKey.txt file exists
            try {
                const apiKey = await fs.readFile(geminiApiKeyFilePath, 'utf8');
                // If the file exists, proceed with generating questions
                await generateQuestions(apiKey);
            } catch (error) {
                if (error.code === 'ENOENT') {
                    // If the file does not exist, prompt the user to enter the API key
                    document.getElementById('api-key-prompt').classList.remove('hidden');
                } else {
                    console.error('Error reading GeminiApiKey.txt:', error);
                }
            }
        });
        contentDetailsContainer.appendChild(generateQuestionsButton);

        // create the html page button
        const generateStudyPageButton = document.createElement('button');
        generateStudyPageButton.textContent = 'Print Questions';
        generateStudyPageButton.id = 'generate-study-page-button';
        generateStudyPageButton.classList.add('generate-study-page');
        generateStudyPageButton.addEventListener('click', async () => {
            await generateHtmlPageWithQuestions();
        });
        contentDetailsContainer.appendChild(generateStudyPageButton);

        // add a span to push the study type buttons to a new line
        const newLineSpan1 = document.createElement('span');
        newLineSpan1.classList.add('new-line');
        contentDetailsContainer.appendChild(newLineSpan1);

         // Create the new button to open a new window
         const openWindowButton = document.createElement('button');
         openWindowButton.textContent = 'Open Slides';
         openWindowButton.classList.add('open-window-button');
         openWindowButton.id = 'open-window-button';
         // Add event listener for the button to open slide viewer
         openWindowButton.addEventListener('click', openSlideViewer);
        contentDetailsContainer.appendChild(openWindowButton);

        // create the html note page button
        const generateNotePageButton = document.createElement('button');
        generateNotePageButton.textContent = 'Print Notes';
        generateNotePageButton.id = 'generate-study-page-button';
        generateNotePageButton.classList.add('generate-study-page');
        generateNotePageButton.addEventListener('click', async () => {
            await generateHtmlPageWithNotes();
        });
        contentDetailsContainer.appendChild(generateNotePageButton);


        // create the html note page button
        const generateAnki = document.createElement('button');
        generateAnki.textContent = 'Make Anki';
        generateAnki.id = 'generate-anki-button';
        generateAnki.classList.add('generate-anki');
        generateAnki.addEventListener('click', async () => {
            await generateAnkiCards();
        });
        contentDetailsContainer.appendChild(generateAnki);

        // add a span to push the study type buttons to a new line
        const newLineSpan2 = document.createElement('span');
        newLineSpan2.classList.add('new-line');
        contentDetailsContainer.appendChild(newLineSpan2);
        contentDetailsContainer.appendChild(newLineSpan2);

        contentDetailsContainer.classList.remove('hidden'); // Show the content details container

        contentNameInput.addEventListener('change', async () => {
            const newName = contentNameInput.value.trim();
            if (newName && newName !== contentDetails.name) {
                await renameContent(contentId, newName);
                contentDetails.name = newName;
            }
        });

        let startTime, endTime;

        function handleButtonClick(studyType) {
            return async () => {
                if (!startTime) {
                    startTime = new Date();
                    //console.log(startTime)
                    //console.log(startTime.toLocaleString())
                    topDownButton.classList.remove('active', 'inactive');
                    bottomUpButton.classList.remove('active', 'inactive');
                    questionsButton.classList.remove('active', 'inactive');

                    topDownButton.disabled = true;
                    bottomUpButton.disabled = true;
                    questionsButton.disabled = true;

                    if (studyType === 'Top Down') {
                        topDownButton.disabled = false;
                        topDownButton.classList.add('active');
                        bottomUpButton.classList.add('inactive');
                        questionsButton.classList.add('inactive');
                    }
                    if (studyType === 'Bottom Up') {
                        bottomUpButton.disabled = false;
                        bottomUpButton.classList.add('active');
                        topDownButton.classList.add('inactive');
                        questionsButton.classList.add('inactive');
                    }
                    if (studyType === 'Questions') {
                        questionsButton.disabled = false;
                        questionsButton.classList.add('active');
                        topDownButton.classList.add('inactive');
                        bottomUpButton.classList.add('inactive');
                    }
                } else {
                    endTime = new Date();
                    const timeElapsed = (endTime - startTime) / 1000; // in seconds

                    const studyTimesFilePath = path.join(currentCourseFolder, 'studyTimes.json');
                    const newStudyTime = {
                        timeElapsed,
                        startTime: startTime.toLocaleString(),
                        endTime: endTime.toLocaleString(),
                        courseId: currentCourseId,
                        contentId: contentId,
                        studyType,
                        name: contentDetails.name
                    };

                    try {
                        let studyTimes = [];
                        const studyTimesFileContent = await fs.readFile(studyTimesFilePath, 'utf8');
                        studyTimes = JSON.parse(studyTimesFileContent);
                        studyTimes.push(newStudyTime);
                        await fs.writeFile(studyTimesFilePath, JSON.stringify(studyTimes, null, 2));
                        console.log('Study time saved successfully.');
                    } catch (error) {
                        console.error('Error writing to studyTimes.json:', error);
                    }

                    const contentFilePath = path.join(currentCourseFolder, 'lectures.json');
                    try {
                        let lectures = [];
                        const lecturesFileContent = await fs.readFile(contentFilePath, 'utf8');
                        lectures = JSON.parse(lecturesFileContent);
                        const lectureIndex = lectures.findIndex(lecture => lecture.id === contentId);
                        if (lectureIndex !== -1) {
                            const today = new Date().toLocaleDateString().split(',')[0];
                            if (!lectures[lectureIndex].daysStudied) {
                                lectures[lectureIndex].daysStudied = [];
                            }
                            if (!lectures[lectureIndex].daysStudied.includes(today)) {
                                lectures[lectureIndex].daysStudied.push(today);
                            }
                            await fs.writeFile(contentFilePath, JSON.stringify(lectures, null, 2));
                            console.log('Lecture updated successfully.');
                            updateDaysStudiedUI(lectures[lectureIndex].daysStudied, daysStudiedContainer); // Update the days studied UI
                        }
                    } catch (error) {
                        console.error('Error updating lectures.json:', error);
                    }

                    topDownButton.disabled = false;
                    bottomUpButton.disabled = false;
                    questionsButton.disabled = false;
                    topDownButton.classList.remove('active', 'inactive');
                    bottomUpButton.classList.remove('active', 'inactive');
                    questionsButton.classList.remove('active', 'inactive');
                    startTime = null;
                    endTime = null;

                    // Populate study times table
                    await populateStudyTimesTable(currentCourseId);

                    // Populate "All" content grid
                    await updateContentGrids();
                }
            };
        }

        const topDownButton = document.createElement('button');
        const bottomUpButton = document.createElement('button');
        const questionsButton = document.createElement('button');

        topDownButton.textContent = 'Top Down';
        bottomUpButton.textContent = 'Bottom Up';
        questionsButton.textContent = 'Questions';

        topDownButton.classList.add('study-button');
        bottomUpButton.classList.add('study-button');
        questionsButton.classList.add('study-button');

        contentDetailsContainer.appendChild(topDownButton);
        contentDetailsContainer.appendChild(bottomUpButton);
        contentDetailsContainer.appendChild(questionsButton);

        topDownButton.addEventListener('click', handleButtonClick('Top Down'));
        bottomUpButton.addEventListener('click', handleButtonClick('Bottom Up'));
        questionsButton.addEventListener('click', handleButtonClick('Questions'));
    }
}

async function renameContent(contentId, newName) {
    const contentFilePath = path.join(currentCourseFolder, 'lectures.json');
    try {
        let lectures = [];
        const lecturesFileContent = await fs.readFile(contentFilePath, 'utf8');
        lectures = JSON.parse(lecturesFileContent);
        const lectureIndex = lectures.findIndex(lecture => lecture.id === contentId);
        if (lectureIndex !== -1) {
            const oldFolderPath = lectures[lectureIndex].folderLink;
            const newFolderPath = path.join(path.dirname(oldFolderPath), newName);

            // Rename the folder
            await fs.rename(oldFolderPath, newFolderPath);

            lectures[lectureIndex].name = newName;
            lectures[lectureIndex].folderLink = newFolderPath;
            await fs.writeFile(contentFilePath, JSON.stringify(lectures, null, 2));
            console.log('Content renamed successfully.');
        }
    } catch (error) {
        console.error('Error renaming content:', error);
    }

    updateContentGrids(); // Call to update the grids after updating the UI
}

async function deleteContent(contentId, contentName) {
    const contentFilePath = path.join(currentCourseFolder, 'lectures.json');
    try {
        let lectures = [];
        const lecturesFileContent = await fs.readFile(contentFilePath, 'utf8');
        lectures = JSON.parse(lecturesFileContent);
        const lectureIndex = lectures.findIndex(lecture => lecture.id === contentId);
        if (lectureIndex !== -1) {
            const folderPath = lectures[lectureIndex].folderLink;
            await fs.rm(folderPath, { recursive: true, force: true });
            lectures.splice(lectureIndex, 1);
            await fs.writeFile(contentFilePath, JSON.stringify(lectures, null, 2));
            console.log('Content deleted successfully.');
        }
    } catch (error) {
        console.error('Error deleting content:', error);
    }

    updateContentGrids(); // Call to update the grids after updating the UI
}



// Function to update days studied UI
function updateDaysStudiedUI(daysStudied, container) {
    container.innerHTML = `<strong>Days Studied: </strong>  ${daysStudied ? daysStudied.reverse().join(', ') : 'None'}`;
}


async function getContentById(contentId) {
    const contentFilePath = path.join(currentCourseFolder, 'lectures.json');
    try {
        const lecturesFileContent = await fs.readFile(contentFilePath, 'utf8');
        const lectures = JSON.parse(lecturesFileContent);
        return lectures.find(lecture => lecture.id === contentId);
    } catch (error) {
        console.log('Error reading lectures.json file:', error);
        return null;
    }
}

// Functions for to do list
async function createToDoFile(courseFolder) {
    const toDoFilePath = path.join(courseFolder, 'toDo.json');
    try {
        await fs.writeFile(toDoFilePath, JSON.stringify([], null, 2));
        console.log(`File "toDo.json" created successfully in "${toDoFilePath}"`);
    } catch (error) {
        console.error(`Error creating "toDo.json": ${error}`);
    }
}

function addNewToDoItem() {
    const newIndex = toDoList.length;
    toDoList.push(""); // Add a blank item to the list
    saveToDoList(toDoList, currentCourseFolder);
    loadToDoList(currentCourseFolder)
    selectToDoItem(newIndex, toDoList);
}

let toDoList = [];

async function loadToDoList(courseFolder) {
    const toDoFilePath = path.join(courseFolder, 'toDo.json');

    try {
        const toDoFileContent = await fs.readFile(toDoFilePath, 'utf8');
        toDoList = JSON.parse(toDoFileContent);
    } catch (error) {
        console.log('No existing toDo.json file found.');
        return;
    }

    const toDoListContainer = document.getElementById('to-do-items'); // Adjusted to target the correct container
    toDoListContainer.innerHTML = ''; // Clear existing list

    toDoList.forEach((toDo, index) => {
        const row = document.createElement('div');
        row.classList.add('to-do-item');
        row.dataset.index = index;

        const taskInput = document.createElement('input');
        taskInput.type = 'text';
        taskInput.value = toDo;
        taskInput.id = 'to-do-editor';
        taskInput.classList.add('to-do-task-input');
        taskInput.addEventListener('change', (e) => {
            toDoList[index] = e.target.value;
            if (e.target.value.trim() === "") {
                toDoList.splice(index, 1); // Remove the item if the text is cleared
                saveToDoList(toDoList, currentCourseFolder);
                loadToDoList(courseFolder);
            } else {
                saveToDoList(toDoList, currentCourseFolder);
            }
            e.target.focus(); // Refocus the input
        });

        row.appendChild(taskInput);
        row.addEventListener('click', () => selectToDoItem(index, toDoList));
        toDoListContainer.appendChild(row);
    });
}

async function saveToDoList(toDoList, courseFolder) {
    const toDoFilePath = path.join(courseFolder, 'toDo.json');
    try {
        await fs.writeFile(toDoFilePath, JSON.stringify(toDoList, null, 2));
        console.log('ToDo list saved successfully.');
    } catch (error) {
        console.error('Error saving ToDo list:', error);
    }
}

let selectedToDoIndex = null;

function selectToDoItem(index, toDoList) {
    // Deselect the previously selected item
    if (selectedToDoIndex !== null) {
        const previousSelectedItem = document.querySelector(`.to-do-item[data-index="${selectedToDoIndex}"]`);
        if (previousSelectedItem) {
            previousSelectedItem.classList.remove('selected');
        }
    }

    // Select the new item
    selectedToDoIndex = index;
    const selectedItem = document.querySelector(`.to-do-item[data-index="${index}"]`);
    if (selectedItem) {
        selectedItem.classList.add('selected');
    }

    console.log(`Selected ToDo: ${toDoList[index]}`);
}

async function loadStudyTypeButtons() {
    const appDataPath = await getAppDataPath();
    const studyTypesFilePath = path.join(appDataPath, 'studyTypes.json');
    let studyTypes = ['Top Down', 'Bottom Up', 'Questions']; // Default study types

    try {
        const fileContent = await fs.readFile(studyTypesFilePath, 'utf8');
        studyTypes = JSON.parse(fileContent);
    } catch (error) {
        console.log('studyTypes.json file does not exist. It will be created.');
    }

    const studyTypeButtonsContainer = document.getElementById('study-type-buttons-container');
    studyTypeButtonsContainer.innerHTML = ''; // Clear existing buttons

    studyTypes.forEach((type) => {
        const button = document.createElement('button');
        button.textContent = type;
        button.classList.add('study-type-button');
        button.addEventListener('click', () => handleStudyTypeButtonClick(type));

        studyTypeButtonsContainer.appendChild(button);
    });
}

let studyStartTime = null;

function handleStudyTypeButtonClick(type) {
    if (studyStartTime) {
        const endTime = new Date();
        const timeElapsed = (endTime - studyStartTime) / 1000; // in seconds

        const studyTimesFilePath = path.join(currentCourseFolder, 'studyTimes.json');
        const newStudyTime = {
            timeElapsed,
            startTime: studyStartTime.toLocaleString(),
            endTime: endTime.toLocaleString(),
            courseId: currentCourseId,
            contentId: null, // Assign contentId if applicable
            studyType: type,
            name: selectedToDoIndex !== null ? toDoList[selectedToDoIndex] : 'Unknown'
        };

        saveStudyTime(newStudyTime, studyTimesFilePath);

        // Reset studyStartTime after saving
        studyStartTime = null;

        // Remove active class from all buttons
        document.querySelectorAll('.study-type-button').forEach(button => button.classList.remove('active', 'inactive'));
    } else {
        studyStartTime = new Date();
        document.querySelectorAll('.study-type-button').forEach(button => button.classList.remove('active'));

        // Find and add active class to the clicked button
        const activeButton = Array.from(document.querySelectorAll('.study-type-button')).find(button => button.textContent === type);
        if (activeButton) {
            activeButton.classList.add('active');
        }

        // Set inactive state for other buttons
        document.querySelectorAll('.study-type-button').forEach(button => {
            if (button.textContent !== type) {
                button.classList.add('inactive');
            }
        });
    }
    populateStudyTimesTable(currentCourseId)
}

async function saveStudyTime(newStudyTime, studyTimesFilePath) {
    let studyTimes = [];

    try {
        const studyTimesFileContent = await fs.readFile(studyTimesFilePath, 'utf8');
        studyTimes = JSON.parse(studyTimesFileContent);
    } catch (error) {
        console.log('No existing studyTimes.json file found.');
    }

    studyTimes.push(newStudyTime);

    try {
        await fs.writeFile(studyTimesFilePath, JSON.stringify(studyTimes, null, 2));
        console.log('Study time saved successfully.');
    } catch (error) {
        console.error('Error saving study time:', error);
    }

    populateStudyTimesTable(currentCourseId)
}

async function initializeChart() {
    const ctx = document.getElementById('study-times-chart').getContext('2d');
    window.studyTimesChart = new Chart(ctx, {
        type: 'bar',
        data: {
            labels: [], // X-axis labels (dates or weeks)
            datasets: [] // Y-axis datasets (study times)
        },
        options: {
            scales: {
                x: {
                    type: 'category',
                    title: {
                        display: true,
                        text: 'Date'
                    }
                },
                y: {
                    title: {
                        display: true,
                        text: 'Time Studied (minutes)'
                    }
                }
            },
            responsive: true,
            plugins: {
                tooltip: {
                    callbacks: {
                        label: function(context) {
                            return context.dataset.label + ': ' + context.raw.toFixed(0) + ' minutes';
                        }
                    }
                }
            }
        }
    });

    // Add event listeners for radio buttons
    document.querySelectorAll('input[name="grouping"]').forEach(radio => {
        radio.addEventListener('change', () => {
            updateChartGrouping();
        });
    });

    await populateStudyTimesTable(currentCourseId);
}



function updateChartGrouping(filteredStudyTimes = window.studyTimes) {
    const grouping = document.querySelector('input[name="grouping"]:checked').value;
    if (grouping === 'days') {
        updateStudyTimesChart(filteredStudyTimes, 'days');
    } else {
        updateStudyTimesChart(filteredStudyTimes, 'weeks');
    }
}



function updateStudyTimesChart(studyTimes, grouping = 'days') {
    const groupedStudyTimes = studyTimes.reduce((acc, curr) => {
        const date = new Date(curr.startTime);
        let key;
        if (grouping === 'weeks') {
            const startOfWeek = new Date(date.setDate(date.getDate() - date.getDay()));
            key = startOfWeek.toLocaleDateString().split(',')[0];
        } else {
            key = date.toLocaleDateString().split(',')[0];
        }

        if (!acc[key]) {
            acc[key] = { date: key };
        }

        if (curr.studyType) {
            if (!acc[key][curr.studyType]) {
                acc[key][curr.studyType] = 0;
            }
            acc[key][curr.studyType] += curr.timeElapsed / 60; // Convert to minutes
        }

        return acc;
    }, {});

    const labels = Object.keys(groupedStudyTimes);
    const studyTypes = new Set(studyTimes.map(st => st.studyType));
    const datasets = Array.from(studyTypes).map(studyType => ({
        label: studyType,
        data: labels.map(label => groupedStudyTimes[label][studyType] || 0),
        stack: 'stack'
    }));

    window.studyTimesChart.data.labels = labels;
    window.studyTimesChart.data.datasets = datasets;
    window.studyTimesChart.update();
}




function updateZoom() {
    const zoomValue = parseInt(document.getElementById('zoom-slider').value, 10);
    const zoomLabel = document.getElementById('zoom-label');

    if (zoomValue >= 100) {
        zoomLabel.textContent = 'All Time';
    } else {
        zoomLabel.textContent = `${Math.floor(zoomValue)} Days`;
    }

    const now = new Date();
    const filteredStudyTimes = window.studyTimes.filter(st => {
        const timeElapsed = (now - new Date(st.startTime)) / 86400000; // time elapsed in hours
        return timeElapsed <= zoomValue;
    });

    updateChartGrouping(filteredStudyTimes); // Re-apply grouping based on the current selection
}



function getFilteredStudyTimes(zoomValue = 100) {
    const now = new Date();
    const filteredStudyTimes = window.studyTimes.filter(st => {
        const timeElapsed = (now - new Date(st.startTime)) / 86400000; // time elapsed in hours
        return timeElapsed <= zoomValue;
    });
    return filteredStudyTimes;
}



// Function to clear content details
function clearContentDetails() {
    const contentDetailName = document.getElementById('content-detail-name');
    const daysStudiedContainer = document.getElementById('days-studied-container');
    const contentDetails = document.getElementById('content-details');

    if (contentDetailName) {
        contentDetailName.textContent = '';
    }
    if (daysStudiedContainer) {
        daysStudiedContainer.innerHTML = '';
    }
    if (contentDetails) {
        contentDetails.classList.add('hidden');
    }

    const contentDetailsContainer = document.getElementById('content-details');
    if (contentDetailsContainer) {
        contentDetailsContainer.innerHTML = ''; // Clear content details
    }
}

async function saveStudyTypes(studyTypes) {
    const appDataPath = await getAppDataPath();
    const studyTypesFilePath = path.join(appDataPath, 'studyTypes.json');
    try {
        await fs.writeFile(studyTypesFilePath, JSON.stringify(studyTypes, null, 2));
        console.log('Study types saved successfully.');
    } catch (error) {
        console.error('Error saving study types:', error);
    }
}


async function openCourse(courseId) {
    const courseNameH1 = document.getElementById('course-name-h1');
    const datePickerBox = document.getElementById('date-picker-box');
    const courseLectureButtonBox = document.getElementById('course-lecture-buttons');
    const studyTypeButtons = document.getElementById('study-type-buttons');
    const studyDaysInput = document.getElementById('study-days-input');
    const saveStudyDaysButton = document.getElementById('save-study-days-button');
    const addContentForm = document.getElementById('add-content-form');
    const contentGridContainer = document.getElementById('content-grid-container');
    const studyTimesContainer = document.getElementById('study-times-container');
    const studyTimesTableBody = document.getElementById('study-times-table').querySelector('tbody');
    const toDoListContainer = document.getElementById('to-do-list-container');
    const studyTypeButtonsContainer = document.getElementById('study-type-buttons-container');
    const course = courses.find(c => c.id === courseId); // Find the course by ID
    const chartContainer = document.getElementById('chart-containter');

    if (course) {
        if (courseNameH1) {
            courseNameH1.textContent = course.name;
            courseNameH1.classList.remove('hidden'); // Ensure it's visible initially
        }
        if (datePickerBox) {
            datePickerBox.classList.remove('hidden');
        }
        if (contentGridContainer) {
            contentGridContainer.classList.remove('hidden');
        }
        if (courseLectureButtonBox) {
            courseLectureButtonBox.classList.remove('hidden');
        }
        if (studyTimesContainer) {
            studyTimesContainer.classList.remove('hidden');
        }
        if (studyTypeButtons){
            studyTypeButtons.classList.remove('hidden');
        }
        if (toDoListContainer) {
            toDoListContainer.classList.remove('hidden');
        }
        if (studyTypeButtonsContainer) {
            studyTypeButtonsContainer.classList.remove('hidden');
        }
        if (chartContainer) {
            chartContainer.classList.remove('hidden');
        }
        const contentNameInput = document.getElementById('content-name');
        const contentDateInput = document.getElementById('content-date');

        currentCourseFolder = course.folderLink; // Set the current course folder
        const studyDaysFilePath = path.join(currentCourseFolder, 'StudyDays.txt');

        // Clear selectedDates and update UI
        selectedDates = [];
        updateSelectedDatesUI();

        // Hide study-days-input and save-study-days-button
        if (studyDaysInput) {
            studyDaysInput.classList.add('hidden');
        }
        if (saveStudyDaysButton) {
            saveStudyDaysButton.classList.add('hidden');
        }

        // Clear the content grid container
        if (contentGridContainer) {
            contentGridContainer.innerHTML = '';
        }
        
        // Hide and reset the add-content-form
        if (addContentForm) {
            addContentForm.classList.add('hidden');
        }
        if (contentNameInput) {
            contentNameInput.value = '';
        }
        if (contentDateInput) {
            contentDateInput.value = '';
        }

        // Clear the content details
        clearContentDetails();

        try {
            const result = await fs.readFile(studyDaysFilePath, 'utf8');
            if (result) {
                const days = result.split(',').map(day => parseInt(day.trim(), 10));
                preSelectStudyDays(days);
            }
        } catch (error) {
            if (error.code === 'ENOENT') {
                console.log('StudyDays.txt file does not exist. It will be created when needed.');
            } else {
                console.error('Error reading StudyDays.txt:', error);
            }
        }

        // Populate "All" content grid
        await updateContentGrids();
        updateSelectedDatesUI();

        // Populate study times table
        await populateStudyTimesTable(courseId);

        // Load ToDo List
        await loadToDoList(currentCourseFolder);

        // Load Study Type Buttons
        await loadStudyTypeButtons();
    }
}

async function populateStudyTimesTable(courseId) {
    const studyTimesFilePath = path.join(currentCourseFolder, 'studyTimes.json');
    const appDataPath = await getAppDataPath();
    const studyTypesFilePath = path.join(appDataPath, 'studyTypes.json');
    let studyTimes = [];
    let studyTypes = ['Top Down', 'Bottom Up', 'Questions']; // Default study types

    try {
        const studyTimesFileContent = await fs.readFile(studyTimesFilePath, 'utf8');
        studyTimes = JSON.parse(studyTimesFileContent);
    } catch (error) {
        console.log('No existing studyTimes.json file found.');
        return;
    }

    try {
        const studyTypesFileContent = await fs.readFile(studyTypesFilePath, 'utf8');
        studyTypes = JSON.parse(studyTypesFileContent);
    } catch (error) {
        console.log('No existing studyTypes.json file found. Using default study types.');
    }

    const studyTimesTableBody = document.getElementById('study-times-table').querySelector('tbody');
    studyTimesTableBody.innerHTML = ''; // Clear existing rows

    const filteredStudyTimes = studyTimes.filter(st => st.courseId === courseId);
    filteredStudyTimes.forEach((studyTime, index) => {
        const row = document.createElement('tr');
        row.dataset.index = index;

        const dateCell = document.createElement('td');
        const dateInput = document.createElement('input');
        dateInput.type = 'text';
        dateInput.value = formatDate(new Date(studyTime.startTime));
        dateInput.classList.add('date-input');
        dateInput.addEventListener('change', async (e) => {
            const newDate = parseDate(e.target.value);
            if (newDate) {
                studyTime.startTime = newDate.toLocaleString();
                await saveStudyTimes(studyTimes);
                updateChartGrouping(); // Update the chart
                e.target.focus(); // Refocus the input
            } else {
                alert('Invalid date format. Please use "MM/DD/YY".');
                e.target.value = formatDate(new Date(studyTime.startTime));
            }
        });
        dateCell.appendChild(dateInput);

        const nameCell = document.createElement('td');
        const nameInput = document.createElement('input');
        nameInput.type = 'text';
        nameInput.value = studyTime.name;
        nameInput.classList.add('name-input');
        nameInput.addEventListener('change', async (e) => {
            studyTime.name = e.target.value;
            await saveStudyTimes(studyTimes);
            updateChartGrouping(); // Update the chart
            e.target.focus(); // Refocus the input
        });
        nameCell.appendChild(nameInput);

        const timeElapsedCell = document.createElement('td');
        const timeElapsedInput = document.createElement('input');
        timeElapsedInput.type = 'text';
        timeElapsedInput.value = formatTimeElapsed(studyTime.timeElapsed);
        timeElapsedInput.classList.add('time-elapsed-input');
        timeElapsedInput.addEventListener('change', async (e) => {
            if (e.target.value === '00:00:00') {
                if (confirm('Are you sure you want to delete this study?')) {
                    studyTimes.splice(index, 1);
                    await saveStudyTimes(studyTimes);
                    populateStudyTimesTable(courseId); // Refresh the table
                } else {
                    timeElapsedInput.value = formatTimeElapsed(studyTime.timeElapsed); // Revert to original value
                }
            } else {
                studyTime.timeElapsed = parseTimeElapsed(e.target.value);
                await saveStudyTimes(studyTimes);
            }
            updateChartGrouping(); // Update the chart
            e.target.focus(); // Refocus the input
        });
        timeElapsedCell.appendChild(timeElapsedInput);

        const studyTypeCell = document.createElement('td');
        const studyTypeSelect = document.createElement('select');
        studyTypes.forEach(type => {
            const option = document.createElement('option');
            option.value = type;
            option.textContent = type;
            if (type === studyTime.studyType) {
                option.selected = true;
            }
            studyTypeSelect.appendChild(option);
        });
        studyTypeSelect.addEventListener('change', async (e) => {
            studyTime.studyType = e.target.value;
            await saveStudyTimes(studyTimes);
            updateChartGrouping(); // Update the chart
            e.target.focus(); // Refocus the select
        });
        studyTypeCell.appendChild(studyTypeSelect);

        row.appendChild(dateCell);
        row.appendChild(nameCell);
        row.appendChild(timeElapsedCell);
        row.appendChild(studyTypeCell);

        // Insert the row at the top of the table body
        studyTimesTableBody.insertBefore(row, studyTimesTableBody.firstChild);
    });

    // Store the study times globally for easy access
    window.studyTimes = filteredStudyTimes;

    // Update the chart with the new study times
    updateChartGrouping(); // Apply grouping based on the current selection
}

function formatDate(date) {
    const month = (date.getMonth() + 1).toString().padStart(2, '0');
    const day = date.getDate().toString().padStart(2, '0');
    const year = date.getFullYear().toString().slice(-2);
    return `${month}/${day}/${year}`;
}

function parseDate(dateString) {
    const [month, day, year] = dateString.split('/').map(Number);
    if (!isNaN(month) && !isNaN(day) && !isNaN(year)) {
        const fullYear = 2000 + year; // Adjust the year to 4 digits
        return new Date(fullYear, month - 1, day);
    }
    return null;
}

function formatTimeElapsed(timeElapsed) {
    const hours = Math.floor(timeElapsed / 3600).toString().padStart(2, '0');
    const minutes = Math.floor((timeElapsed % 3600) / 60).toString().padStart(2, '0');
    const seconds = (timeElapsed % 60).toString().padStart(2, '0');
    return `${hours}:${minutes}:${seconds}`;
}

function parseTimeElapsed(timeString) {
    const [hours, minutes, seconds] = timeString.split(':').map(Number);
    return (hours * 3600) + (minutes * 60) + seconds;
}

async function saveStudyTimes(studyTimes) {
    const studyTimesFilePath = path.join(currentCourseFolder, 'studyTimes.json');
    try {
        await fs.writeFile(studyTimesFilePath, JSON.stringify(studyTimes, null, 2));
        console.log('Study times saved successfully.');
    } catch (error) {
        console.error('Error saving study times:', error);
    }
}


function closeCourse() {
    const courseNameH1 = document.getElementById('course-name-h1');
    const datePickerBox = document.getElementById('date-picker-box');
    const courseLectureButtonBox = document.getElementById('course-lecture-buttons');
    const studyTypeButtons = document.getElementById('study-type-buttons');
    const studyDaysInput = document.getElementById('study-days-input');
    const saveStudyDaysButton = document.getElementById('save-study-days-button');
    const addContentForm = document.getElementById('add-content-form');
    const contentNameInput = document.getElementById('content-name');
    const contentDateInput = document.getElementById('content-date');
    const contentGridContainer = document.getElementById('content-grid-container');
    const toDoListContainer = document.getElementById('to-do-list-container');
    const studyTypeButtonsContainer = document.getElementById('study-type-buttons-container');
    const chartContainer = document.getElementById('chart-containter');
    
    courseNameH1.textContent = null;
    courseNameH1.classList.add('hidden'); // Ensure it's hidden
    datePickerBox.classList.add('hidden');
    courseLectureButtonBox.classList.add('hidden');
    studyTypeButtons.classList.add('hidden');
    studyDaysInput.classList.add('hidden');
    saveStudyDaysButton.classList.add('hidden');
    addContentForm.classList.add('hidden');
    contentGridContainer.classList.add('hidden');
    toDoListContainer.classList.add('hidden');
    studyTypeButtonsContainer.classList.add('hidden');
    chartContainer.classList.add('hidden');

    // Clear selectedDates and update UI
    selectedDates = [];
    updateSelectedDatesUI();

    // Reset the add-content-form
    contentNameInput.value = '';
    contentDateInput.value = '';

    // Clear the content grid container
    contentGridContainer.innerHTML = '';

    // Clear the content details
    clearContentDetails();
}

// Function to generate a course button
function generateCourseButton(courseName, courseId, isHidden) {
    const button = document.createElement('button');
    button.textContent = courseName;
    button.id = 'classButtons';

    // Add click event listener for each course button
    button.addEventListener('click', () => {
        currentCourseId = courseId; // Set the current course ID
        // Show the form with pre-filled data for the selected course
        document.getElementById('course-name').value = courseName;
        document.getElementById('create-course-button').textContent = 'Rename Course';
        if(showingHiddenCourses){
            document.getElementById('hide-course-button').classList.remove('hidden');
            document.getElementById('hide-course-button').textContent = isHidden ? 'Show Course' : 'Hide Course';
            document.getElementById('course-form').classList.remove('hidden');
        }

        // Update the left side
        openCourse(courseId);
    });

    // Append button to course buttons container
    document.getElementById('course-buttons-container').appendChild(button);
}

// Function to load courses from courses.json and generate buttons
async function loadCourses(showHidden = false) {
    try {
        const appDataPath = await getAppDataPath();
        const coursesFilePath = path.join(appDataPath, 'courses.json');

        const coursesFileContent = await fs.readFile(coursesFilePath, 'utf8');
        courses = JSON.parse(coursesFileContent);

        // Debugging: Check the parsed courses
        console.log('Courses loaded:', courses);

        // Clear existing course buttons
        document.getElementById('course-buttons-container').innerHTML = '';

        // Generate buttons for each course
        courses.forEach(course => {
            if (showHidden || course.CourseShown !== false) {
                generateCourseButton(course.name, course.id, course.CourseShown === false);
            }
        });
    } catch (error) {
        console.error('Error reading courses.json:', error);
    }
}

async function ensureDefaultStudyTypes() {
    const defaultStudyTypes = ['Top Down', 'Bottom Up', 'Questions'];
    const appDataPath = await getAppDataPath();
    const studyTypesFilePath = path.join(appDataPath, 'studyTypes.json');

    try {
        await fs.access(studyTypesFilePath);
    } catch (error) {
        if (error.code === 'ENOENT') {
            await saveStudyTypes(defaultStudyTypes);
        }
    }
}

async function initializeCal() {
    try {
        const appDataPath = await getAppDataPath();
        const calURLFilePath = path.join(appDataPath, 'CalURL.txt');

        await loadCalendarURL(calURLFilePath);

        const addCalendarButton = document.getElementById('add-calendar-button');
        const calendarInputContainer = document.getElementById('calendar-input-container');
        const calendarURLInput = document.getElementById('calendar-url-input');
        const saveCalendarURLButton = document.getElementById('save-calendar-url-button');

        addCalendarButton.addEventListener('click', async () => {
            calendarInputContainer.classList.toggle('hidden');
            try {
                const url = await fs.readFile(calURLFilePath, 'utf8');
                calendarURLInput.value = url;
            } catch (error) {
                if (error.code === 'ENOENT') {
                    console.log('CalURL.txt does not exist. No URL to load.');
                } else {
                    console.error('Error reading CalURL.txt:', error);
                }
            }
        });

        saveCalendarURLButton.addEventListener('click', async () => {
            const url = calendarURLInput.value.trim();
            if (url) {
                try {
                    await fs.writeFile(calURLFilePath, url, 'utf8');
                    createIframe(url);
                    calendarInputContainer.classList.add('hidden');
                    console.log('Calendar URL saved successfully.');
                } catch (error) {
                    console.error('Error saving CalURL.txt:', error);
                }
            } else {
                alert('Please enter a valid calendar URL.');
            }
        });
    } catch (error) {
        console.error('Error during initialization:', error);
    }
}

async function loadCalendarURL(calURLFilePath) {
    try {
        const url = await fs.readFile(calURLFilePath, 'utf8');
        createIframe(url);
    } catch (error) {
        if (error.code === 'ENOENT') {
            console.log('CalURL.txt does not exist. No calendar to display.');
        } else {
            console.error('Error reading CalURL.txt:', error);
        }
    }
}

function createIframe(url) {
    const iframeContainer = document.getElementById('calendar-iframe-container');
    iframeContainer.innerHTML = ''; // Clear any existing iframes
    const iframe = document.createElement('iframe');
    iframe.src = url;
    iframe.style.border = '0';
    iframe.width = '800';
    iframe.height = '600';
    iframe.frameBorder = '0';
    iframe.scrolling = 'no';
    iframeContainer.appendChild(iframe);
}

document.addEventListener('DOMContentLoaded', () => {
    // Load existing courses on startup
    loadCourses();

    currentCourseFolder = getAppDataPath();

    try {
        const coursesFileContent = fs.readFile(coursesFilePath, 'utf8');
        courses = JSON.parse(coursesFileContent);
        console.log('Initial loading of courses.');
    } catch (error) {
        console.log('No existing courses.json file found. Creating a new one.');
    }

    const addCourseButton = document.getElementById('add-course-button');
    const courseForm = document.getElementById('course-form');
    const createCourseButton = document.getElementById('create-course-button');
    const cancelCreateCourseButton = document.getElementById('cancel-create-course-button');
    const hideCourseButton = document.getElementById('hide-course-button');
    const showHiddenCoursesButton = document.getElementById('show-hidden-courses-button');
    const setStudyDaysButton = document.getElementById('set-study-days-button');
    const studyDaysInput = document.getElementById('study-days-input');
    const saveStudyDaysButton = document.getElementById('save-study-days-button');
    const datePicker = document.getElementById('date-picker');
    const selectedDatesContainer = document.getElementById('selected-dates');
    const addContentForm = document.getElementById('add-content-form');
    const saveContentButton = document.getElementById('save-content-button');
    const contentNameInput = document.getElementById('content-name');
    const contentDateInput = document.getElementById('content-date');
    const addContentButton = document.getElementById('add-content-button');

    const addToDoButton = document.getElementById('add-to-do-button');
    addToDoButton.addEventListener('click', addNewToDoItem);

    // Ensure default study types are saved if the file doesn't exist
    ensureDefaultStudyTypes();

    addCourseButton.addEventListener('click', () => {
        // Reset form for creating a new course
        currentCourseId = null;
        document.getElementById('course-name').value = '';
        createCourseButton.textContent = 'Create Course';
        hideCourseButton.classList.add('hidden');
        courseForm.classList.remove('hidden');
        closeCourse();
    });

    cancelCreateCourseButton.addEventListener('click', () => {
        courseForm.classList.toggle('hidden');
        closeCourse();
    });

    createCourseButton.addEventListener('click', async () => {
        const courseName = document.getElementById('course-name').value.trim();
    
        if (courseName) {
            try {
                const appDataPath = await getAppDataPath();
                const coursesFilePath = path.join(appDataPath, 'courses.json');
                
                let courses = [];
                try {
                    const coursesFileContent = await fs.readFile(coursesFilePath, 'utf8');
                    courses = JSON.parse(coursesFileContent);
                } catch (error) {
                    console.log('No existing courses.json file found. Creating a new one.');
                }
    
                if (currentCourseId) {
                    // Rename the existing course
                    const courseIndex = courses.findIndex(course => course.id === currentCourseId);
                    if (courseIndex !== -1) {
                        const oldFolderName = removeSpaces(courses[courseIndex].name);
                        const newFolderName = removeSpaces(courseName);
    
                        // Rename the folder
                        const oldFolderPath = path.join(appDataPath, oldFolderName);
                        const newFolderPath = path.join(appDataPath, newFolderName);
                        await fs.rename(oldFolderPath, newFolderPath);
                        console.log(`Folder renamed from "${oldFolderName}" to "${newFolderName}"`);
    
                        // Update the course details
                        courses[courseIndex].name = courseName;
                        courses[courseIndex].folderLink = newFolderPath;
    
                        // Update the button text
                        const courseButton = document.querySelector(`#course-buttons-container button:nth-child(${courseIndex + 1})`);
                        if (courseButton) {
                            courseButton.textContent = courseName;
                        }
                    }
    
                    // Update the name header
                    openCourse(currentCourseId);
                } else {
                    // Create a new course
                    const folderName = removeSpaces(courseName);
                    const folderPath = path.join(appDataPath, folderName);
    
                    // Create the folder
                    await fs.mkdir(folderPath, { recursive: true });
                    console.log(`Folder "${folderName}" created at "${folderPath}"`);
    
                    // Create the lectures.json
                    const lecturesFilePath = path.join(folderPath, 'lectures.json');
                    try {
                        const fileExists = await fs.access(lecturesFilePath).then(() => true).catch(() => false);
                        if (!fileExists) {
                            await fs.writeFile(lecturesFilePath, JSON.stringify([], null, 2));
                            console.log(`File "lectures.json" created successfully in "${lecturesFilePath}"`);
                        } else {
                            console.log(`File "lectures.json" already exists in "${lecturesFilePath}"`);
                        }
                    } catch (error) {
                        console.error(`Error creating "lectures.json": ${error}`);
                    }
    
                    // Create the studyTimes.json
                    const studyTimesFilePath = path.join(folderPath, 'studyTimes.json');
                    try {
                        const fileExists = await fs.access(studyTimesFilePath).then(() => true).catch(() => false);
                        if (!fileExists) {
                            await fs.writeFile(studyTimesFilePath, JSON.stringify([], null, 2));
                            console.log(`File "studyTimes.json" created successfully in "${studyTimesFilePath}"`);
                        } else {
                            console.log(`File "studyTimes.json" already exists in "${studyTimesFilePath}"`);
                        }
                    } catch (error) {
                        console.error(`Error creating "studyTimes.json": ${error}`);
                    }
    
                    // Create the new course object
                    const newCourse = {
                        id: generateRandomId(),
                        name: courseName,
                        folderLink: folderPath,
                        CourseShown: true // Default to shown
                    };
    
                    // Add the new course to the list
                    courses.push(newCourse);
    
                    // Generate a new button for the course
                    generateCourseButton(courseName, newCourse.id, false);
                    closeCourse();
                    courseForm.classList.toggle('hidden');

                    // Create the to do list json
                     await createToDoFile(folderPath);
                }
    
                // Write the updated courses back to courses.json
                await fs.writeFile(coursesFilePath, JSON.stringify(courses, null, 2));
                console.log(`Course "${courseName}" updated in courses.json`);
                loadCourses(showingHiddenCourses);
    
            } catch (error) {
                console.error('Error processing course:', error);
            }
        } else {
            alert('Please enter a course name.');
        }
    
        // Reset form after submission
        document.getElementById('course-name').value = '';
        courseForm.classList.add('hidden');
        currentCourseId = null;
        createCourseButton.textContent = 'Create Course';
    });
    

    hideCourseButton.addEventListener('click', async () => {
        if (currentCourseId) {
            try {
                const appDataPath = await getAppDataPath();
                const coursesFilePath = path.join(appDataPath, 'courses.json');

                const coursesFileContent = await fs.readFile(coursesFilePath, 'utf8');
                courses = JSON.parse(coursesFileContent);

                const courseIndex = courses.findIndex(course => course.id === currentCourseId);
                if (courseIndex !== -1) {
                    // Toggle the CourseShown property
                    courses[courseIndex].CourseShown = !courses[courseIndex].CourseShown;

                    // Write the updated courses back to courses.json
                    await fs.writeFile(coursesFilePath, JSON.stringify(courses, null, 2));
                    console.log(`Course "${courses[courseIndex].name}" ${courses[courseIndex].CourseShown ? 'shown' : 'hidden'} in courses.json`);

                    // Update the button text and visibility
                    const courseButton = document.querySelector(`#course-buttons-container button:nth-child(${courseIndex + 1})`);
                    if (courseButton) {
                        if (!courses[courseIndex].CourseShown) {
                            //courseButton.remove();
                            //loadCourses(showingHiddenCourses);

                            if(!showingHiddenCourses){
                                courseButton.remove();

                                // Optionally, reset form and hide
                                document.getElementById('course-name').value = '';
                                courseForm.classList.add('hidden');

                                // Update the <h1> with the course name and toggle its visibility
                                closeCourse();
                            }else{
                                loadCourses(showingHiddenCourses);
                            }
                        }
                    }

                    // Update the hide button text
                    hideCourseButton.textContent = courses[courseIndex].CourseShown ? 'Hide Course' : 'Show Course';
                }
            } catch (error) {
                console.error('Error toggling course visibility:', error);
            }
        } else {
            alert('No course selected to hide/show.');
        }
    });

    // Toggle showing hidden courses
    showHiddenCoursesButton.addEventListener('click', () => {
        showingHiddenCourses = !showingHiddenCourses;
        loadCourses(showingHiddenCourses);
        showHiddenCoursesButton.textContent = showingHiddenCourses ? 'Back' : 'Edit ';

        // if edit is clicked, the current course is loaded in the edit form
        if(showingHiddenCourses){
            console.log(`Showing hidden courses`);
            document.getElementById('course-form').classList.remove('hidden');
        } else {
            courseForm.classList.add('hidden'); 
        }
    });

    setStudyDaysButton.addEventListener('click', async () => {
        // Show the input and save button
        studyDaysInput.classList.remove('hidden');
        saveStudyDaysButton.classList.remove('hidden');

        // Load current study days
        const studyDaysFilePath = path.join(currentCourseFolder, 'StudyDays.txt');
        let currentDays = '';
        try {
            currentDays = await fs.readFile(studyDaysFilePath, 'utf8');
        } catch (error) {
            console.log('StudyDays.txt file does not exist. It will be created.');
        }
        studyDaysInput.value = currentDays;
    });

    saveStudyDaysButton.addEventListener('click', async () => {
        const newDays = studyDaysInput.value;
        const studyDaysFilePath = path.join(currentCourseFolder, 'StudyDays.txt');
        
        if (newDays === '') {
            // If no characters are entered, clear the study days
            try {
                await fs.writeFile(studyDaysFilePath, '');
                console.log(`StudyDays.txt file cleared successfully.`);
                studyDaysInput.classList.add('hidden');
                saveStudyDaysButton.classList.add('hidden');
                selectedDates = []; // Clear selected dates
                updateSelectedDatesUI(); // Update the date labels
            } catch (error) {
                console.error(`Error clearing StudyDays.txt: ${error.message}`);
            }
        } else if (/^(-?\d+)(,-?\d+)*$/.test(newDays)) {
            // If valid format, save the study days
            try {
                await fs.writeFile(studyDaysFilePath, newDays);
                console.log(`StudyDays.txt file updated successfully.`);
                studyDaysInput.classList.add('hidden');
                saveStudyDaysButton.classList.add('hidden');
                const days = newDays.split(',').map(day => parseInt(day.trim(), 10));
                preSelectStudyDays(days); // Update the date labels
            } catch (error) {
                console.error(`Error writing to StudyDays.txt: ${error.message}`);
            }
        } else {
            alert('Invalid format. Please enter numbers separated by commas.');
        }
    });
    
    

    datePicker.addEventListener('change', (event) => {
        let selectedDate = event.target.value;

        const dateParts = selectedDate.split(/[-/]/); // Split by hyphen or slash
        const myDay = dateParts[dateParts.length - 1];
        const myMonth = Number(dateParts[dateParts.length - 2]);
        const myYear = Number(dateParts[dateParts.length - 3]);
  
        // Create a Date object
        //const date = new Date(myYear, myMonth - 1, myDay); // Month is 0-indexed
        selectedDate = new Date();

        // Set the year
        selectedDate.setFullYear(myYear);

        // Set the month (remembering that months are 0-indexed, so July is 6)
        selectedDate.setMonth(myMonth-1);

        // Set the day
        selectedDate.setDate(myDay);

        selectedDate = `${myMonth}/${myDay}/${myYear}`;

        console.log(selectedDate)
        console.log(selectedDates)

        if (selectedDate && !selectedDates.includes(selectedDate)) {
            selectedDates.unshift(selectedDate); // Add to the beginning of the array
            updateSelectedDatesUI();
        }
        datePicker.value = ''; // Reset the input field
        event.target.focus(); // Refocus the input
    });

    // Add event listener for the "Add Content" button
    addContentButton.addEventListener('click', () => {
        addContentForm.classList.remove('hidden');
    });
    
    // Add event listener for the "Save" button in the "Add Content" form
    saveContentButton.addEventListener('click', async () => {
        const contentName = contentNameInput.value.trim();
        let contentDate = contentDateInput.value;
        const dateParts = contentDate.split('-');
        contentDate = `${Number(dateParts[1])}/${Number(dateParts[2])}/${dateParts[0]}`;

    if (contentName && contentDate) {
        const contentFilePath = path.join(currentCourseFolder, 'lectures.json');
        let lectures = [];

        try {
            const lecturesFileContent = await fs.readFile(contentFilePath, 'utf8');
            lectures = JSON.parse(lecturesFileContent);
        } catch (error) {
            console.log('No existing lectures.json file found. Creating a new one.');
        }

        const newContentId = generateRandomId();
        const contentFolderPath = path.join(currentCourseFolder, removeSpaces(contentName));
        const mediaStoragePath = path.join(contentFolderPath, 'mediaStorage');
        const mediaFilePath = path.join(contentFolderPath, 'media.json');

        const newContent = {
            id: newContentId,
            name: contentName,
            date: contentDate,
            parentCourseId: currentCourseId,
            daysStudied: null,
            folderLink: contentFolderPath
        };

        lectures.push(newContent);

        try {
            // Create the folder for the content
            await fs.mkdir(contentFolderPath, { recursive: true });
            console.log(`Folder "${contentFolderPath}" created successfully.`);

            // Create the mediaStorage folder
            await fs.mkdir(mediaStoragePath, { recursive: true });
            console.log(`Folder "${mediaStoragePath}" created successfully.`);

            // Create a blank media.json file
            await fs.writeFile(mediaFilePath, JSON.stringify([], null, 2));
            console.log(`File "media.json" created successfully in "${mediaFilePath}"`);

            // Update the lectures.json file
            await fs.writeFile(contentFilePath, JSON.stringify(lectures, null, 2));
            console.log(`Content "${contentName}" saved successfully.`);
            
            contentNameInput.value = '';
            contentDateInput.value = '';
            addContentForm.classList.add('hidden');
        } catch (error) {
            console.error(`Error writing to lectures.json: ${error.message}`);
        }
    } else {
        alert('Please enter both content name and date.');
    }

    updateContentGrids();
    });

    const addRandomDayButton = document.getElementById('add-random-day-button');

    addRandomDayButton.addEventListener('click', async () => {
        await addRandomDay();
    });

    async function addRandomDay() {
        const contentFilePath = path.join(currentCourseFolder, 'lectures.json');
        let lectures = [];

        try {
            const lecturesFileContent = await fs.readFile(contentFilePath, 'utf8');
            lectures = JSON.parse(lecturesFileContent);
        } catch (error) {
            console.log('No existing lectures.json file found.');
            return;
        }

        // Filter out lectures already shown in selectedDates
        const shownDates = new Set(selectedDates);
        //alert(shownDates);
        const availableLectures = lectures.filter(lecture => !shownDates.has(lecture.date));

        if (availableLectures.length === 0) {
            alert('No more lectures available to add.');
            return;
        }

        // Pick a random lecture from the available ones
        const randomLecture = availableLectures[Math.floor(Math.random() * availableLectures.length)];
        selectedDates.unshift(randomLecture.date); // Add to the beginning of the array
        updateSelectedDatesUI();
        updateContentGrids();
    }

    const setStudyTypesButton = document.getElementById('set-study-types-button');
    const studyTypesInput = document.getElementById('study-types-input');
    const saveStudyTypesButton = document.getElementById('save-study-types-button');
    const toDoListContainer = document.getElementById('to-do-list-container');
    const studyTypeButtonsContainer = document.getElementById('study-type-buttons-container');


    setStudyTypesButton.addEventListener('click', async () => {
        // Show the input and save button
        studyTypesInput.classList.remove('hidden');
        saveStudyTypesButton.classList.remove('hidden');

        // Load current study types
        const appDataPath = await getAppDataPath();
        const studyTypesFilePath = path.join(appDataPath, 'studyTypes.json');
        let currentTypes = ['Top Down', 'Bottom Up', 'Questions']; // Default study types
        try {
            const fileContent = await fs.readFile(studyTypesFilePath, 'utf8');
            currentTypes = JSON.parse(fileContent);
        } catch (error) {
            console.log('studyTypes.json file does not exist. It will be created.');
        }
        studyTypesInput.value = currentTypes.join(', ');
    });

    saveStudyTypesButton.addEventListener('click', async () => {
        const newTypes = studyTypesInput.value.split(',').map(type => type.trim());
        if (newTypes.length) {
            const appDataPath = await getAppDataPath();
            const studyTypesFilePath = path.join(appDataPath, 'studyTypes.json');
            try {
                await saveStudyTypes(newTypes);
                console.log(`studyTypes.json file updated successfully.`);
                studyTypesInput.classList.add('hidden');
                saveStudyTypesButton.classList.add('hidden');
            } catch (error) {
                console.error(`Error writing to studyTypes.json: ${error.message}`);
            }
        } else {
            alert('Please enter valid study types.');
        }
    });

    loadStudyTypeButtons(); // Load study type buttons on startup

    document.querySelectorAll('input[name="grouping"]').forEach((input) => {
        input.addEventListener('change', updateChartGrouping);
    });
    document.getElementById('zoom-slider').addEventListener('input', updateZoom);

    initializeChart();

    // Event listener for the zoom slider
    const zoomSlider = document.getElementById('zoom-slider');
    zoomSlider.addEventListener('input', updateZoom);

    // API Key

// Event listener for the Save API Key button
document.getElementById('save-api-key-button').addEventListener('click', async () => {
    const apiKey = document.getElementById('gemini-api-key-input').value.trim();
    if (apiKey) {
        const appDataPath = await getAppDataPath();
        const geminiApiKeyFilePath = path.join(appDataPath, 'GeminiApiKey.txt');
        try {
            await fs.writeFile(geminiApiKeyFilePath, apiKey, 'utf8');
            document.getElementById('api-key-prompt').classList.add('hidden');
            await generateQuestions(apiKey); // Proceed with generating questions using the provided API key
        } catch (error) {
            console.error('Error saving Gemini API Key:', error);
        }
    } else {
        alert('Please enter a valid Gemini API Key.');
    }
});

// for calendar
initializeCal();

document.getElementById('prev-slide').addEventListener('click', () => {
    if (currentSlideIndex > 0) {
        currentSlideIndex--;
        displaySlide(currentSlideIndex);
    }
});

document.getElementById('next-slide').addEventListener('click', () => {
    if (currentSlideIndex < slides.length - 1) {
        currentSlideIndex++;
        displaySlide(currentSlideIndex);
    }
});

document.getElementById('back-button').addEventListener('click', () => {
    document.getElementById('slide-viewer').classList.add('hidden');
    document.getElementById('nav-panel').classList.remove('hidden');
    document.getElementById('main-content').classList.remove('hidden');
});



}); // end of DOM

