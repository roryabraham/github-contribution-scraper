const moment = require('moment-timezone');
const CONST = require('./CONST');

/**
 * Get all the dates between the two given dates.
 *
 * @param {String} startDate
 * @param {String} endDate
 * @returns {Array<String>}
 * @throws {Error} If either of the provided dates are not valid
 */
function enumerateDaysBetweenDates(startDate, endDate) {
    const dates = [];

    const currDate = moment(startDate).startOf('day');
    const lastDate = moment(endDate).startOf('day');

    while(currDate.add(1, 'days').diff(lastDate) < 0) {
        dates.push(currDate.clone().toDate());
    }

    return dates;
}

/**
 * Is the given string a valid timezone in moment.js ?
 *
 * @param {String} timezone
 * @returns {Boolean}
 */
function isValidTimezone(timezone) {
    return moment.tz.zone(timezone) != null;
}

/**
 * Adjust the startDate and endDate for the given timezone, then format it for GitHub.
 *
 * @param {String} timezone
 * @param {String} startDate
 * @param {String} endDate
 * @returns {{endDate: String, twoWeeksBefore: String, startDate: String}}
 */
function adjustDateAndTimezoneForGitHub(timezone, startDate, endDate) {
    return {
        startDate: moment.tz(`${startDate} 00:00:00`, timezone)
            .format(CONST.GITHUB_TIMEZONE_FORMAT),
        endDate: moment.tz(`${endDate} 23:59:59`, timezone)
            .format(CONST.GITHUB_TIMEZONE_FORMAT),
        twoWeeksBefore: moment.tz(`${startDate} 00:00:00`, timezone)
            .subtract(14, 'days')
            .format(CONST.GITHUB_TIMEZONE_FORMAT),
    };
}

/**
 * Is the given date a weekday?
 *
 * @param {String} date
 * @returns {Boolean}
 */
function isWeekday(date) {
    return !(moment(date).day() % 6 === 0);
}

/**
 * @param {String} date
 * @returns {String}
 */
function formatDateForOutput(date) {
    return moment(date).format(CONST.DATE_FORMAT_OUTPUT).toUpperCase();
}

module.exports = {
    enumerateDaysBetweenDates,
    isValidTimezone,
    adjustDateAndTimezoneForGitHub,
    isWeekday,
    formatDateForOutput,
};
