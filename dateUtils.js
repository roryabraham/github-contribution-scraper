const moment = require('moment-timezone');

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
function isValidTimeZone(timezone) {
    return moment.tz.zone(timezone) != null;
}

module.exports = {
    enumerateDaysBetweenDates,
    isValidTimeZone,
};
