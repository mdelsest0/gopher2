<<<<<<< HEAD
const { ipcRenderer } = require('electron');
const fs = require('fs').promises;
const path = require('path');

let slides = [];
let currentSlideIndex = 0;

document.addEventListener('DOMContentLoaded', () => {
    let slides = [];
    let currentSlideIndex = 0;

    // Receive slides data from main process
    window.api.receive('slides-data', (data) => {
        slides = data;
        if (slides.length > 0) {
            displaySlide(0);
        }
        document.getElementById('prev-slide').addEventListener('click', () => navigateSlide(-1));
        document.getElementById('next-slide').addEventListener('click', () => navigateSlide(1));
        updateNavigationButtons();
    });

    function displaySlide(index) {
        const slide = slides[index];
        const slideImg = document.getElementById('slide');
        slideImg.src = `file://${slide.filePath}`;
        currentSlideIndex = index;
        updateNavigationButtons();
    }

    function navigateSlide(direction) {
        const newIndex = currentSlideIndex + direction;
        if (newIndex >= 0 && newIndex < slides.length) {
            displaySlide(newIndex);
        }
    }

    function updateNavigationButtons() {
        document.getElementById('prev-slide').disabled = currentSlideIndex === 0;
        document.getElementById('next-slide').disabled = currentSlideIndex === slides.length - 1;
    }
});

=======
const { ipcRenderer } = require('electron');
const fs = require('fs').promises;
const path = require('path');

let slides = [];
let currentSlideIndex = 0;

document.addEventListener('DOMContentLoaded', () => {
    let slides = [];
    let currentSlideIndex = 0;

    // Receive slides data from main process
    window.api.receive('slides-data', (data) => {
        slides = data;
        if (slides.length > 0) {
            displaySlide(0);
        }
        document.getElementById('prev-slide').addEventListener('click', () => navigateSlide(-1));
        document.getElementById('next-slide').addEventListener('click', () => navigateSlide(1));
        updateNavigationButtons();
    });

    function displaySlide(index) {
        const slide = slides[index];
        const slideImg = document.getElementById('slide');
        slideImg.src = `file://${slide.filePath}`;
        currentSlideIndex = index;
        updateNavigationButtons();
    }

    function navigateSlide(direction) {
        const newIndex = currentSlideIndex + direction;
        if (newIndex >= 0 && newIndex < slides.length) {
            displaySlide(newIndex);
        }
    }

    function updateNavigationButtons() {
        document.getElementById('prev-slide').disabled = currentSlideIndex === 0;
        document.getElementById('next-slide').disabled = currentSlideIndex === slides.length - 1;
    }
});

>>>>>>> ceb8c533ee505d381993db81c3c738d212b24e55
