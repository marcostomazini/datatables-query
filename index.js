'use strict';

var async = require('async'),

    /**
     * Method getSearchableFields
     * Returns an array of fieldNames based on DataTable params object
     * All columns in params.columns that have .searchable == true field will have the .data param returned in an String
     * array. The .data property is used because in angular frontend DTColumnBuilder.newColumn('str') puts 'str' in the
     * data field, instead of the name field.
     * @param params
     * @returns {Array}
     */
    getSearchableFields = function (params) {
        return params.columns.filter(function (column) {
            return JSON.parse(column.searchable);
        }).map(function (column) {
            return column.data;
        });
    },

    /**
     * Method getSearchableCustomFields        
     * @param params
     * @returns {Array}
     */
    getSearchableCustomFields = function (params) {
        return params.searchCustom.filter(function (column) {
            return column.value;
        }).map(function (column) {
            var search = {};
            search[column.name] = new RegExp(column.value, 'i');
            return search;
        });
    },

    /**
     * Method isNaNorUndefined
     * Checks if any of the passed params is NaN or undefined.
     * Used to check DataTable's properties draw, start and length
     * @returns {boolean}
     */
    isNaNorUndefined = function () {
        var args = Array.prototype.slice.call(arguments);
        return args.some(function (arg) {
            return isNaN(arg) || (!arg && arg !== 0);
        });
    },

    /**
     * Methdd buildFindParameters
     * Builds a MongoDB find expression based on DataTables param object
     * - If no search text if provided (in params.search.value) an empty object is returned, meaning all data in DB will
     * be returned.
     * - If only one column is searchable (that means, only one params.columns[i].searchable equals true) a normal one
     * field regex MongoDB query is returned, that is {`fieldName`: new Regex(params.search.value, 'i'}
     * - If multiple columns are searchable, an $or MongoDB is returned, that is:
     * ```
     * {
     *     $or: [
     *         {`searchableField1`: new Regex(params.search.value, 'i')},
     *         {`searchableField2`: new Regex(params.search.value, 'i')}
     *     ]
     * }
     * ```
     * and so on.<br>
     * All search are by regex so the field param.search.regex is ignored.
     * @param params DataTable params object
     * @returns {*}
     */
    buildFindParameters = function (params) {

        if (!params || !params.columns || !params.search || 
            (!params.search.value && params.search.value !== '')) {
            return null;
        }

        var searchText = params.search.value,
            findParameters = {},
            searchRegex,            
            searchOrArray = [];    

        var searchableFields = getSearchableCustomFields(params);        
        if (searchableFields.length > 0) {        
            findParameters.$and = searchableFields;
            console.log(findParameters);
            return findParameters;
        }

        if (searchText === '') {
            return findParameters;
        }

        searchRegex = new RegExp(searchText, 'i');

        searchableFields = getSearchableFields(params);

        if (searchableFields.length === 1) {
            findParameters[searchableFields[0]] = searchRegex;
            return findParameters;
        }

        searchableFields.forEach(function (field) {
            var orCondition = {};
            orCondition[field] = searchRegex;
            searchOrArray.push(orCondition);
        });       

        findParameters.$or = searchOrArray;
        
        return findParameters;
    },

    /**
     * Method buildSortParameters
     * Based on DataTable parameters, this method returns a MongoDB ordering parameter for the appropriate field
     * The params object must contain the following properties:
     * order: Array containing a single object
     * order[0].column: A string parseable to an Integer, that references the column index of the reference field
     * order[0].dir: A string that can be either 'asc' for ascending order or 'desc' for descending order
     * columns: Array of column's description object
     * columns[i].data: The name of the field in MongoDB. If the index i is equal to order[0].column, and
     * the column is orderable, then this will be the returned search param
     * columns[i].orderable: A string (either 'true' or 'false') that denotes if the given column is orderable
     * @param params
     * @returns {*}
     */
    buildSortParameters = function (params) {
        if (!params || !Array.isArray(params.order) || params.order.length === 0) {
            return null;
        }

        var sortColumn = Number(params.order[0].column),
            sortOrder = params.order[0].dir,
            sortField;

        if (isNaNorUndefined(sortColumn) || !Array.isArray(params.columns) || sortColumn >= params.columns.length) {
            return null;
        }

        if (params.columns[sortColumn].orderable === 'false') {
            return null;
        }

        sortField = params.columns[sortColumn].data;

        if (!sortField) {
            return null;
        }

        if (sortOrder === 'asc') {
            return sortField;
        }

        return '-' + sortField;
    },

    /**
     * Run wrapper function
     * Serves only to the Model parameter in the wrapped run function's scope
     * @param {Object} Model Mongoose Model Object, target of the search
     * @returns {Function} the actual run function with Model in its scope
     */
    run = function (Model) {

        /**
         * Method Run
         * The actual run function
         * Performs the query on the passed Model object, using the DataTable params argument
         * @param {Object} params DataTable params object
         */
        return function (params) {

            var draw = Number(params.draw),
                start = Number(params.start),
                length = Number(params.length),
                findParameters = buildFindParameters(params),
                sortParameters = buildSortParameters(params),
                recordsTotal,
                recordsFiltered;

            return new Promise(function (fullfill, reject) {

                async.series([
                    function checkParams (cb) {
                        if (isNaNorUndefined(draw, start, length)) {
                            return cb(new Error('Some parameters are missing or in a wrong state. ' +
                            'Could be any of draw, start or length'));
                        }
                        if (!findParameters || !sortParameters) {
                            return cb(new Error('Invalid findParameters or sortParameters'));
                        }
                        cb();
                    },
                    function fetchRecordsTotal (cb) {
                        Model.count({}, function (err, count) {
                            if (err) {
                                cb(err);
                            }
                            recordsTotal = count;
                            cb();
                        });
                    },
                    function fetchRecordsFiltered (cb) {
                        Model.count(findParameters, function (err, count) {
                            if (err) {
                                cb(err);
                            }
                            recordsFiltered = count;
                            cb();
                        });
                    },
                    function runQuery (cb) {
                        Model
                            .find(findParameters)
                            .populate('leilao', 'date')
                            .limit(length)
                            .skip(start)
                            .sort(sortParameters)
                            .exec(function (err, results) {
                                if (err) {
                                    cb(err);
                                }
                                cb(null, {
                                    draw: draw,
                                    recordsTotal: recordsTotal,
                                    recordsFiltered: recordsFiltered,
                                    data: results
                                });
                            });

                    }
                ], function resolve (err, results) {
                    if (err) {
                        reject({
                            error: err
                        });
                    } else {
                        var answer = results[results.length - 1];
                        fullfill(answer);
                    }
                });
            });
        };
    },

    /**
     * Module datatablesQuery
     * Performs queries in the given Mongoose Model object, following DataTables conventions for search and
     * pagination.
     * The only interesting exported function is `run`. The others are exported only to allow unit testing.
     * @param Model
     * @returns {{run: Function, isNaNorUndefined: Function, buildFindParameters: Function, buildSortParameters:
     *     Function}}
     */
    datatablesQuery = function (Model) {
        return {
            run: run(Model),
            isNaNorUndefined: isNaNorUndefined,
            buildFindParameters: buildFindParameters,
            buildSortParameters: buildSortParameters
        }
    };

module.exports = datatablesQuery;
