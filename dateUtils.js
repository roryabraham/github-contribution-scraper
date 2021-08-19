const moment = require('moment');

function enumerateDaysBetweenDates (startDate, endDate) {
    const dates = [];

    const currDate = moment(startDate).startOf('day');
    const lastDate = moment(endDate).startOf('day');

    while(currDate.add(1, 'days').diff(lastDate) < 0) {
        dates.push(currDate.clone().toDate());
    }

    return dates;
}

module.exports = {
    enumerateDaysBetweenDates,
};
