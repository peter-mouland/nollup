/*
    This module looks through all lines of the code and checks for import and export statements.
    Each of these statements are then converted to CommonJS require and export calls.
    It does the trick for now.

    Issues:
        - No support for live bindings. Not sure if I want to break debugging symbols though for a trivial feature.

*/
let acorn = require('acorn');
let MagicString = require('magic-string');

function isExternal(context, name) {
    if (context && context.options.external) {
        let external = context.options.external;
        if (Array.isArray(external)) {
            return external.indexOf(name) > -1;
        }

        if (typeof external === 'function') {
            return external(name);
        }
    }

    return false;
}

function resolveExternalImport (context, response, node) {
    let transpiled = '';
    let importAlias = '';
    let globalConf = (context.options.output && context.options.output.globals) || {};
    let defaultNode;
    let globalName; 

    if ((node.specifiers && node.specifiers.length > 0) || node.type === 'ExportAllDeclaration') {
        defaultNode = node.specifiers && node.specifiers.filter(n => n.type === 'ImportDefaultSpecifier')[0];

        // Need to figure out global name.
        // First use the configuration, else use the default name, else the source value.
        globalName = (
            globalConf[node.source.value] || 
            (defaultNode && defaultNode.local.name) || 
            node.source.value
        );

        importAlias = '_e' + globalName;
        transpiled += `var ${importAlias} = window.${globalName};`
    }

    if (node.specifiers && node.specifiers.length > 0) {
        node.specifiers.forEach(node => {
            if (node.type === 'ImportDefaultSpecifier') {
                transpiled += `var ${node.local.name} = ${importAlias} && ${importAlias}.hasOwnProperty("default")? ${importAlias}.default : ${importAlias};`;
            }

            if (node.type === 'ImportSpecifier') {
                transpiled += `var ${node.local.name} = ${importAlias}.${node.imported.name};`;
            }

            if (node.type === 'ImportNamespaceSpecifier') {
                transpiled += `var ${node.local.name} = ${importAlias}`;
            }
        });
    }

    return { transpiled, importAlias };
}

function resolveInternalImport (context, response, node) {
    let importIndex = response.dependencies.length;
    let importAlias = `_i${importIndex}`;
    let transpiled = `var ${importAlias} = require(__nollup__${importIndex});`;
    response.dependencies.push(node.source.value);

    if (node.specifiers && node.specifiers.length > 0) {
        node.specifiers.forEach(node => {
            if (node.type === 'ImportDefaultSpecifier') {
                transpiled += `var ${node.local.name} = ${importAlias}.default;`;
            }

            if (node.type === 'ImportSpecifier') {
                transpiled += `var ${node.local.name} = ${importAlias}.${node.imported.name};`;
            }

            if (node.type === 'ImportNamespaceSpecifier') {
                transpiled += `var ${node.local.name} = ${importAlias};`;
            }
        });
    }

    return { transpiled, importAlias };
}

function resolveImport (context, response, node) {
    if (isExternal(context, node.source.value)) {
        return resolveExternalImport(context, response, node);
    } else {
        return resolveInternalImport(context, response, node);
    }
}

module.exports = function (input, context) {
    let ast;

    let response = {
        output: new MagicString(input),
        dependencies: []
    };

    try {
        ast = acorn.parse(input, {
            ecmaVersion: 2018,
            sourceType: 'module',
            preserveParens: false
        });
    } catch (e) {
        let err = [
            e.name + ': ' + e.message,
            '    ' + input.split('\n')[e.loc.line - 1],
            '    ' +  '^'.padStart(e.loc.column)
        ].join('\n');

        throw err;
    }

    for (let i = 0; i < ast.body.length; i++) {
        let node = ast.body[i];

        if (node.type === 'ImportDeclaration') {
            let transpiled = resolveImport(context, response, node).transpiled;

            // TODO: Multi-line imports may break source maps
            response.output.overwrite(node.start, node.end, transpiled);
        } 

        if (node.type === 'ExportDefaultDeclaration') {
            if (node.declaration.id) {
                response.output.overwrite(node.start, node.declaration.start, '');
                response.output.appendRight(node.declaration.end, `; module.exports.default = ${node.declaration.id.name};`);
            } else {
                response.output.overwrite(node.start, node.declaration.start, `module.exports.default = `);
            }
        }

        if (node.type === 'ExportNamedDeclaration') {

            if (node.declaration) {
                if (node.declaration.id) {
                    response.output.overwrite(node.start, node.declaration.start, '');
                    response.output.appendRight(node.declaration.end, `; module.exports.${node.declaration.id.name} = ${node.declaration.id.name};`);
                } else if (node.declaration.declarations) {
                    response.output.overwrite(node.start, node.declaration.start, '');

                    let output = '; ' + node.declaration.declarations.map(node => {
                        return `module.exports.${node.id.name} = ${node.id.name}`;
                    }).join(', ') + ';';
                    response.output.appendRight(node.declaration.end, output);
                }
            } else if (node.specifiers) {
                let importAlias, transpiled = '';

                // Export {} from statements
                if (node.source) {
                    let tmp = resolveImport(context, response, node);
                    importAlias = tmp.importAlias;
                    transpiled = tmp.transpiled;
                }

                node.specifiers.forEach(node => {
                    if (node.type === 'ExportSpecifier') {
                        if (importAlias !== undefined) {
                            transpiled += `module.exports.${node.exported.name} = ${importAlias}.${node.local.name};`;
                        } else {
                            transpiled += `module.exports.${node.exported.name} = ${node.local.name};`;
                        }
                    }
                });

                response.output.overwrite(node.start, node.end, transpiled);
            }
        }

        if (node.type === 'ExportAllDeclaration') {
            let { transpiled, importAlias } = resolveImport(context, response, node);
            transpiled += `for(var k in ${importAlias}){k !== "default" && (module.exports[k] = ${importAlias}[k])}`;
            response.output.overwrite(node.start, node.end, transpiled);
        }

    }

    return { output: response.output.toString(), dependencies: response.dependencies };
}