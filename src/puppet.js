#!/usr/bin/env node
require('dotenv').config()
const fs = require('fs')
const puppeteer = require('puppeteer')
const tough = require('tough-cookie')
const cookieutil = require('./cookie.js')
const isDocker = require('is-docker')

const nodeFetch = require('node-fetch')

if(!process.env.MY_UH_PEOPLESOFT_ID)
    console.log('[⛔] Must define MY_UH_PEOPLESOFT_ID in environment or .env file')
if(!process.env.MY_UH_PASSWORD)
    console.log('[⛔] Must define MY_UH_PASSWORD in environment or .env file')
if(!process.env.MY_UH_PEOPLESOFT_ID || !process.env.MY_UH_PASSWORD)
    process.exit(1)

/**
 * Called when puppet.js is ran as a script
 */
module.exports.cli = async function () {
    const argv = require('yargs')
    .option('outfile', {
        alias: 'o'
    })
    .describe('outfile', 'File where JSON CookieJar will be saved to. Leaving empty will output cookiestring to stdout.')
    .argv

    if(!process.env.MY_UH_PEOPLESOFT_ID)
        console.log('[⛔] Must define MY_UH_PEOPLESOFT_ID in environment or .env file')
    if(!process.env.MY_UH_PASSWORD)
        console.log('[⛔] Must define MY_UH_PASSWORD in environment or .env file')
    if(!process.env.MY_UH_PEOPLESOFT_ID || !process.env.MY_UH_PASSWORD)
        process.exit(1)
    
    try {
        let data = await module.exports.extract(process.env.MY_UH_PEOPLESOFT_ID, process.env.MY_UH_PASSWORD, {
            logging: true,
            format: argv.outfile ? 'jar' : 'set-cookie',
        })

        if(argv.outfile) {
            fs.writeFileSync(argv.outfile, data)
            console.log(`[🍪] CookieJar written to ${argv.outfile}`)
        }
        else {
            console.log(data)
        }
    }
    catch(err) {
        console.log('[🚫] A fatal exception occurred:\n', err)
        process.exit(1)
    }
}

/**
 * Crawls the UH portal and returns the extracted cookie from https://uh.collegescheduler.com
 * @async
 * @param {string} psid - UH PeopleSoft ID number
 * @param {string} password - UH password
 * @param {object} options - { logging: [true|false], format: ['set-cookie'|'jar']}
 * @returns {Promise<tough.CookieJar>}
 * @throws {Exception} - TODO: more descriptive error names
 */
module.exports.extract  = async function (psid, password, options) {
    // serialized jar is the default format
    options.format = options.format !== 'set-cookie' ? 'jar' : 'set-cookie';

    // Puppeteer setup
    const browser = await puppeteer.launch({ args: isDocker() ? ['--no-sandbox', '--disable-setuid-sandbox'] : [] })
    const page = await browser.newPage();

    if(options.logging) console.log('[🐋] Detected to be running inside Docker. Chrome sandbox disabled.')

    if(options.logging) console.log('[💬] Login https://my.uh.edu ...')
    await page.goto('https://my.uh.edu');

    // Select "UH Central"
    await page.waitFor('label[for=myuh]')
    await page.click('label[for=myuh]')

    // Type username
    await page.waitFor('#userid')
    await page.focus('#userid')
    await page.keyboard.type(psid)
    
    // Type password
    await page.waitFor('#pwd')
    await page.focus('#pwd')
    await page.keyboard.type(password)

    // Submit button
    await page.waitFor('input[type=Submit]')

    // Wait for login form to submit
    const [response] = await Promise.all([
        page.waitForNavigation(), // The promise resolves after navigation has finished
        page.click('input[type=Submit]'), // Clicking the link will indirectly cause a navigation
    ]);
    
    if(options.logging) console.log(response.headers()['respondingwithsignonpage'] ? '[⛔] Denied' : '[✅] Logged in!')
    
    if(response.headers()['respondingwithsignonpage']) {
        if(options.logging) console.log('Closing browser because UH login denied')
        await browser.close()
        throw new Exception('Closing browser because UH login denied')
    }

    if(options.logging) console.log('[💬] Portalling (Student Center -> Schedule Planner) ...')
    // "Student Center"
    await page.waitFor(`div[id='win0divPTNUI_LAND_REC_GROUPLET$3']`)
    await page.click(`div[id='win0divPTNUI_LAND_REC_GROUPLET$3']`)

    // inner peoplesoft iframe
    await page.waitFor('#ptifrmtgtframe')
    const frame = await page.frames().find(frame => frame.name() === 'TargetContent');

    // "Schedule Planner"
    await frame.waitFor('#PRJCS_DERIVED_PRJCS_SCHD_PLN_PB')
    await frame.click('#PRJCS_DERIVED_PRJCS_SCHD_PLN_PB')
    
    // "Open Schedule Planner"
    await frame.waitFor('#win0divPRJCS_DERIVED_PRJCS_LAUNCH_CS')
    await frame.click('#win0divPRJCS_DERIVED_PRJCS_LAUNCH_CS')

    // Wait for tab Popup window to open
    await browser.waitForTarget(target => target.url().includes('collegescheduler'))

    // Select "page" that is what we're looking for
    const scheduler = (await browser.pages()).filter(e => e.url().includes('collegescheduler'))[0]

    // Wait for the page to load
    await scheduler.waitFor('#Term-options')

    if(options.logging) console.log('[📝] Extracting cookies https://uh.collegescheduler.com ...')

    // Extract the cookies
    let pupcookies = await scheduler.cookies('https://uh.collegescheduler.com');
    let cookiejar = new tough.CookieJar();
    for(let i = 0; i < pupcookies.length; i++)
        cookiejar.setCookieSync(cookieutil.puppeteerToTough(pupcookies[i]), `${pupcookies[i].secure ? 'https://' : 'http://'}${pupcookies[i].domain}${pupcookies[i].path}`);
    
    const fetch = require('fetch-cookie/node-fetch')(nodeFetch, cookiejar)

    let res = await fetch('https://uh.collegescheduler.com/api/terms/')
    if(options.logging) console.log(res.status !== 200 ? `[⚠] Faulty HTTP code: ${res.status}` : '[✅] API access confirmed')
    
    if(res.status !== 200) {
        if(options.logging) console.log('Closing because faulty HTTP code.')
        await browser.close()
        throw new Exception('Closing because faulty HTTP code.')
    }

    await browser.close()
    // returns JSON or cookiestring depending on option
    return options.format !== 'set-cookie' ? JSON.stringify(cookiejar.serializeSync(), null, 1) : cookiejar.getCookieStringSync('https://uh.collegescheduler.com')
}


if (require.main === module) {
    module.exports.cli()
}

