//#region state

/** 
 * The injected "get full distribution" button
 * @type {HTMLElement}
 */
let injectedBtn = null
/** 
 * Has injected plotly script into the page
 * @type {boolean}
 */
let hasInjectedPlotly = false
/**
 * The grades list for the current course.
 * Since we inject a new content script to each course, this cache cannot be invalidated.
 * @type {number[]}
 */
let gradesCache = null
/**
 * How many grades were already checked out of 100
 * @type {number}
 */
let gradesChecked = -1
/**
 * Is the script currently download grades
 * @type {boolean}
 */
let isRunning = false

//#endregion

//#region utils

/** 
 * @return {boolean} if the content script runs on the right page
 */
function isInRightPage() {
    const titleElem = document.querySelector('span#LblPage.pagekots')
    return titleElem && titleElem.innerText == 'התפלגות ציונים בקורס' && window.self !== window.top
}

/**
 * @return {(userId: string) => string} get factory for grades url for the current page
 */
function getRequestUrl() {
    if (document.location.href.includes("www.ims.tau.ac.il")) {
        return userId => `https://www.ims.tau.ac.il/Tal/TP/Tziunim_Chart.aspx?id=${userId}`

    } else {
        return userId => `https://iims.tau.ac.il/tal/TP/Tziunim_Chart.aspx?id=${userId}`
    }
}

//#endregion

//#region functionality

/**
 * Get the required course fields
 * @return {{group: string, year: string, semester: string, courseId: string, userId: string, courseName: string}}
 */
function getFields() {
    const groupElement = document.querySelector('#lstKv')
    const group = groupElement.options[groupElement.selectedIndex].value || ''

    const semesterElement = document.querySelector('div.listtd > b:nth-child(2)')
    const [year, semesterNumber] = semesterElement.innerText.split('/')
    const semester = year + semesterNumber

    const courseElement = document.querySelector('div.listtd > b:nth-child(1)')
    const [courseId, courseName] = courseElement.innerText.split('-')

    const idElement = document.querySelector('#frmfree')
    const userId = new URL(idElement.action).searchParams.get('id')

    return { group, year, semester, courseId, userId, courseName }
}

/**
 * Get the grades for the given course
 * @param {{semester: string, courseId: string, userId: string}} param0 The course info
 * @param {() => void} updateListener Will called on every new grade added
 * @return {number[]} an array of length 101, where `array[i]` is how many students got the grade `i`
 */
async function getGrades({ semester, courseId, userId }, updateListener) {
    const reported = []
    const grades = [0]
    const requestUrl = getRequestUrl()(userId)
    for (let grade = 1; grade <= 100; grade++) {
        const response = await fetch(requestUrl,
            {
                "credentials": "include", "headers": {
                    "Content-Type": "application/x-www-form-urlencoded",
                },
                "body": `kurs=${courseId}&sem=${semester}&kv=&sem_kvutza=${semester}&grade=${grade}&javas=1&caller=tziunim`,
                "method": "POST",
                "mode": "cors"
            })

        const body = await response.text().then(t => { updateListener(); return t })
        const doc = new DOMParser().parseFromString(body, "text/html")
        const cell = [...doc.querySelectorAll("table.table.rounddiv tr:nth-child(2) td:nth-child(8)")]

        reported[0] = parseInt(doc.querySelector("table.table.rounddiv tr:nth-child(1) td:nth-child(2)").textContent.trim()) + 1

        if (cell.length == 0) {
            reported[grade] = reported[grade - 1]
            grades[grade] = 0
        } else {
            const num = parseInt(cell[0].textContent.trim())

            reported[grade] = num
            grades[grade] = reported[grade - 1] - reported[grade]
        }
    }
    gradesCache = grades
    return grades
}
//#endregion

//#region UI

/**
 * Inject our button to the UI and register the listener for on click event
 * @param {() => void} listener Listener to run on click
 * @return {boolean} if the injection was successful
 */
function injectButton(listener) {
    const showBtn = document.querySelector('#btnshow')
    if (!showBtn)
        return false

    injectedBtn = document.createElement('button')
    showBtn.parentElement.appendChild(injectedBtn)

    injectedBtn.style.color = 'white'
    injectedBtn.style.borderRadius = '12px'
    injectedBtn.style.background = 'linear-gradient(90deg, #3587EB 100%, white 0%)'
    injectedBtn.style.marginRight = '10px'
    injectedBtn.innerText = 'הצג התפלגות מלאה'

    injectedBtn.onclick = listener

    return true
}

/**
 * Inject plotly to page if needed, and then show a dialog with the grades
 * @param {number[]} grades An array with 101 cells, each for a grade
 * @param {string} courseName The name of the course
 */
function showGradesDialog(grades, courseName) {
    if (!hasInjectedPlotly) {
        const scriptTag = document.createElement('script')
        scriptTag.setAttribute("type", "text/javascript")
        scriptTag.setAttribute("src", chrome.runtime.getURL("src/js/plotly-latest.min.js"))
        scriptTag.onload = () => showGradesDialogInternal(grades, courseName)
        document.getElementsByTagName("head")[0].appendChild(scriptTag)

        hasInjectedPlotly = true
    } else {
        showGradesDialogInternal(grades, courseName)
    }
}

/**
 * Show a dialog with the grades
 * @param {number[]} grades An array with 101 cells, each for a grade
 * @param {string} courseName The name of the course
 */
function showGradesDialogInternal(grades, courseName) {
    document.body.setAttribute("__grades", JSON.stringify(grades))
    document.body.setAttribute("__name", courseName)

    const injectedCode = '(' + function () {
        const dialogElement = document.createElement('div')
        document.body.appendChild(dialogElement)

        const data = [{
            x: [...Array(101).keys()],
            y: JSON.parse(document.body.getAttribute('__grades')),
            type: 'bar'
        }]

        Plotly.newPlot(dialogElement, data, {
            title: document.body.getAttribute('__name'),
            xaxis: {
                title: 'Grade',
                dtick: 5
            },
            yaxis: {
                title: 'Students',
            },
        }, { showSendToCloud: true })


        $(dialogElement).dialog({
            modal: true,
            height: "auto",
            width: "auto"
        });
    } + ')()'

    var script = document.createElement('script')
    script.textContent = injectedCode;
    (document.head || document.documentElement).appendChild(script)
    script.remove()
}

/**
 * On new grade added, update the loading UI
 */
function onUpdate() {
    gradesChecked++
    injectedBtn.style.background = `linear-gradient(90deg, #3587EB ${gradesChecked}%, white ${100 - gradesChecked}%)`
}

//#endregion


function onClick() {
    console.log("Hacked");

    (async () => {
        if (!isRunning) {
            isRunning = true

            onUpdate()

            const fields = getFields()
            const grades = gradesCache != null ? gradesCache : await getGrades(fields, onUpdate)

            console.log("Grades for course:", fields.courseName, JSON.stringify(grades))
            showGradesDialog(grades, fields.courseName)

            isRunning = false
        }
    })()
    return false
}

function main() {
    if (!isInRightPage())
        return

    injectButton(onClick)
}

function mainWrapper() {
    if (document.readyState === "complete") {
        setTimeout(main)
    } else {
        setTimeout(mainWrapper, 100)
    }
}

mainWrapper()