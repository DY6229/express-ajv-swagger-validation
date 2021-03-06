'use strict';

var SwaggerParser = require('swagger-parser'),
    Ajv = require('ajv'),
    Validators = require('./utils/validators'),
    filesKeyword = require('./customKeywords/files'),
    contentKeyword = require('./customKeywords/contentTypeValidation'),
    InputValidationError = require('./inputValidationError'),
    schemaPreprocessor = require('./utils/schema-preprocessor'),
    sourceResolver = require('./utils/sourceResolver');

var schemas = {};
var middlewareOptions;
var ajvConfigBody;
var ajvConfigParams;
var framework;

/**
 * Initialize the input validation middleware
 * @param {string} swaggerPath - the path for the swagger file
 * @param {Object} options - options.formats to add formats to ajv, options.beautifyErrors, options.firstError, options.expectFormFieldsInBody, options.fileNameField (default is 'fieldname' - multer package), options.ajvConfigBody and options.ajvConfigParams for config object that will be passed for creation of Ajv instance used for validation of body and parameters appropriately
 */
function init(swaggerPath, options) {
    middlewareOptions = options || {};
    ajvConfigBody = middlewareOptions.ajvConfigBody || {};
    ajvConfigParams = middlewareOptions.ajvConfigParams || {};
    framework = middlewareOptions.framework ? require(`./frameworks/${middlewareOptions.framework}`) : require('./frameworks/express');
    const makeOptionalAttributesNullable = middlewareOptions.makeOptionalAttributesNullable || false;

    return Promise.all([
        SwaggerParser.dereference(swaggerPath),
        SwaggerParser.parse(swaggerPath)
    ]).then(function (swaggers) {
        const dereferenced = swaggers[0];
        Object.keys(dereferenced.paths).forEach(function (currentPath) {
            let pathParameters = dereferenced.paths[currentPath].parameters || [];
            let parsedPath = dereferenced.basePath && dereferenced.basePath !== '/' ? dereferenced.basePath.concat(currentPath.replace(/{/g, ':').replace(/}/g, '')) : currentPath.replace(/{/g, ':').replace(/}/g, '');
            schemas[parsedPath] = {};
            Object.keys(dereferenced.paths[currentPath]).filter(function (parameter) { return parameter !== 'parameters' })
                .forEach(function (currentMethod) {
                    schemas[parsedPath][currentMethod.toLowerCase()] = {};

                    const parameters = dereferenced.paths[currentPath][currentMethod].parameters || [];

                    let bodySchema = middlewareOptions.expectFormFieldsInBody
                        ? parameters.filter(function (parameter) { return (parameter.in === 'body' || (parameter.in === 'formData' && parameter.type !== 'file')) })
                        : parameters.filter(function (parameter) { return parameter.in === 'body' });

                    if (makeOptionalAttributesNullable) {
                        schemaPreprocessor.makeOptionalAttributesNullable(bodySchema);
                    }
                    if (bodySchema.length > 0) {
                        const validatedBodySchema = _getValidatedBodySchema(bodySchema);
                        schemas[parsedPath][currentMethod].body = buildBodyValidation(validatedBodySchema, dereferenced.definitions, swaggers[1], currentPath, currentMethod, parsedPath);
                    }

                    let localParameters = parameters.filter(function (parameter) {
                        return parameter.in !== 'body';
                    }).concat(pathParameters);

                    if (localParameters.length > 0 || middlewareOptions.contentTypeValidation) {
                        schemas[parsedPath][currentMethod].parameters = buildParametersValidation(localParameters,
                            dereferenced.paths[currentPath][currentMethod].consumes || dereferenced.paths[currentPath].consumes || dereferenced.consumes);
                    }
                });
        });
    })
        .catch(function (error) {
            return Promise.reject(error);
        });
}

function _getValidatedBodySchema(bodySchema) {
    let validatedBodySchema;
    if (bodySchema[0].in === 'body') {
        // if we are processing schema for a simple JSON payload, no additional processing needed
        validatedBodySchema = bodySchema[0].schema;
    } else if (bodySchema[0].in === 'formData') {
        // if we are processing multipart form, assemble body schema from form field schemas
        validatedBodySchema = {
            required: [],
            properties: {}
        };
        bodySchema.forEach((formField) => {
            if (formField.type !== 'file') {
                validatedBodySchema.properties[formField.name] = {
                    type: formField.type
                };
                if (formField.required) {
                    validatedBodySchema.required.push(formField.name);
                }
            }
        });
    }
    return validatedBodySchema;
}

/**
 * The middleware - should be called for each express route
 * @param {any} req
 * @param {any} res
 * @param {any} next
 * @returns In case of an error will call `next` with `InputValidationError`
 */
function validate(...args) {
    return framework.validate(_validateRequest, ...args);
}

function _validateRequest(requestOptions) {
    return Promise.all([
        _validateParams(requestOptions.headers, requestOptions.params, requestOptions.query, requestOptions.files, requestOptions.path, requestOptions.method.toLowerCase()).catch(e => e),
        _validateBody(requestOptions.body, requestOptions.path, requestOptions.method.toLowerCase()).catch(e => e)
    ]).then(function (errors) {
        if (errors[0] || errors[1]) {
            return errors[0] && errors[1] ? Promise.reject(errors[0].concat(errors[1])) : errors[0] ? Promise.reject(errors[0]) : Promise.reject(errors[1]);
        }
    }).catch(function (errors) {
        const error = new InputValidationError(errors, requestOptions.path, requestOptions.method.toLowerCase(),
            { beautifyErrors: middlewareOptions.beautifyErrors,
                firstError: middlewareOptions.firstError });
        return Promise.resolve(error);
    });
}

function _validateBody(body, path, method) {
    return new Promise(function (resolve, reject) {
        if (schemas[path][method].body && !schemas[path][method].body.validate(body)) {
            return reject(schemas[path][method].body.errors);
        }
        return resolve();
    });
}

function _validateParams(headers, pathParams, query, files, path, method) {
    return new Promise(function (resolve, reject) {
        if (schemas[path][method].parameters && !schemas[path][method].parameters({ query: query, headers: headers, path: pathParams, files: files })) {
            return reject(schemas[path][method].parameters.errors);
        }

        return resolve();
    });
}

function addCustomKeyword(ajv, formats) {
    if (formats) {
        formats.forEach(function (format) {
            ajv.addFormat(format.name, format.pattern);
        });
    }

    ajv.addKeyword('files', filesKeyword);
    ajv.addKeyword('content', contentKeyword);
}

function buildBodyValidation(schema, swaggerDefinitions, originalSwagger, currentPath, currentMethod, parsedPath) {
    const defaultAjvOptions = {
        allErrors: true
        // unknownFormats: 'ignore'
    };
    const options = Object.assign({}, defaultAjvOptions, ajvConfigBody);
    let ajv = new Ajv(options);

    addCustomKeyword(ajv, middlewareOptions.formats);

    if (schema.discriminator) {
        return buildInheritance(schema.discriminator, swaggerDefinitions, originalSwagger, currentPath, currentMethod, parsedPath, ajv);
    } else {
        return new Validators.SimpleValidator(ajv.compile(schema));
    }
}

function buildInheritance(discriminator, dereferencedDefinitions, swagger, currentPath, currentMethod, parsedPath, ajv) {
    let bodySchema = swagger.paths[currentPath][currentMethod].parameters.filter(function (parameter) { return parameter.in === 'body' })[0];
    var inheritsObject = {
        inheritance: []
    };
    inheritsObject.discriminator = discriminator;

    Object.keys(swagger.definitions).forEach(key => {
        if (swagger.definitions[key].allOf) {
            swagger.definitions[key].allOf.forEach(element => {
                if (element['$ref'] && element['$ref'] === bodySchema.schema['$ref']) {
                    inheritsObject[key] = ajv.compile(dereferencedDefinitions[key]);
                    inheritsObject.inheritance.push(key);
                }
            });
        }
    }, this);

    return new Validators.OneOfValidator(inheritsObject);
}

function createContentTypeHeaders(validate, contentTypes) {
    if (!validate || !contentTypes) return;

    return {
        types: contentTypes
    };
}

function buildParametersValidation(parameters, contentTypes) {
    const defaultAjvOptions = {
        allErrors: true,
        coerceTypes: 'array'
        // unknownFormats: 'ignore'
    };
    const options = Object.assign({}, defaultAjvOptions, ajvConfigParams);
    let ajv = new Ajv(options);

    addCustomKeyword(ajv, middlewareOptions.formats);

    var ajvParametersSchema = {
        title: 'HTTP parameters',
        type: 'object',
        additionalProperties: false,
        properties: {
            headers: {
                title: 'HTTP headers',
                type: 'object',
                properties: {},
                additionalProperties: true
                // plural: 'headers'
            },
            path: {
                title: 'HTTP path',
                type: 'object',
                properties: {},
                additionalProperties: false
            },
            query: {
                title: 'HTTP query',
                type: 'object',
                properties: {},
                additionalProperties: false
            },
            files: {
                title: 'HTTP form files',
                files: {
                    required: [],
                    optional: []
                }
            }
        }
    };

    parameters.forEach(parameter => {
        var data = Object.assign({}, parameter);

        const required = parameter.required;
        const source = sourceResolver.resolveParameterSource(parameter);
        const key = parameter.in === 'header' ? parameter.name.toLowerCase() : parameter.name;

        var destination = ajvParametersSchema.properties[source];

        delete data.name;
        delete data.in;
        delete data.required;

        if (data.type === 'file') {
            required ? destination.files.required.push(key) : destination.files.optional.push(key);
        } else if (source !== 'fields') {
            if (required) {
                destination.required = destination.required || [];
                destination.required.push(key);
            }
            destination.properties[key] = data;
        }
    }, this);

    ajvParametersSchema.properties.headers.content = createContentTypeHeaders(middlewareOptions.contentTypeValidation, contentTypes);

    return ajv.compile(ajvParametersSchema);
}

module.exports = {
    init: init,
    validate: validate,
    InputValidationError: InputValidationError
};
