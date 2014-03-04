import optimist from 'optimist';
import fs from 'fs';
import path from 'path';
import through from 'through';
import js_beautify from 'js-beautify';

function extend(target, ...sources) {
  var toString = {}.toString;

  sources.forEach(function(source) {
    for (var key in source) {
      target[key] = source[key];
    }
  });

  return target;
}

function normalizePath(p) {
  return p.replace(/\\/g, '/');
}

class CLI {
  constructor(Compiler, AbstractCompiler, stdin=process.stdin, stdout=process.stdout, fs_=fs) {
    this.Compiler = Compiler;
    this.AbstractCompiler = AbstractCompiler;
    this.stdin = stdin;
    this.stdout = stdout;
    this.fs = fs_;
  }

  // THIS IS A HACK.
  // DEMONSTRATION PURPOSES ONLY.
  // DO NOT USE THIS, EVER.
  countFiles(files, dir) {
    var count = 0;
    dir = dir || "";

    files.forEach(function (file) {
        if (file[0] !== ".") {
            var stat = this.fs.statSync(dir + file);
            if (stat.isFile()) {
                ++count;
            } else if (stat.isDirectory()) {
                dir = dir + file + "/";
                count += this.countFiles(this.fs.readdirSync(file), dir);
            }
        }
    }.bind(this));

    return count;
  }

  start(argv) {
    var options = this.parseArgs(argv), outputFilename;

    if (options.help) {
      this.argParser(argv).showHelp();
    } else if (options.stdio) {
      this.processStdio(options);
    } else {
      var length = options._.length;
      var remainingFiles = this.countFiles(options._.slice(2));
      for (var i = 2; i < length; i++) {
        var filename = options._[i];
        this.processPath(filename, options, function () {
            if (--remainingFiles === 0) {
                var outputFilename = normalizePath(path.join(options.to, "graph.json"));
                this.fs.writeFile(outputFilename, js_beautify(JSON.stringify(options.graph)));
            }
        }.bind(this));
      }
    }
  }

  parseArgs(argv) {
    var args = this.argParser(argv).argv;

    if (args.imports) {
      var imports = {};
      args.imports.split(',').forEach(function(pair) {
        var [requirePath, global] = pair.split(':');
        imports[requirePath] = global;
      });
      args.imports = imports;
    }

    if (args.global) {
      args.into = args.global;
    }

    if (args.graph) {
        args.graph = {};
    }
    return args;
  }

  argParser(argv) {
    return optimist(argv).usage('compile-modules usage:\n\n  Using files:\n    compile-modules INPUT --to DIR [--infer-name] [--type TYPE] [--imports PATH:GLOBAL]\n\n  Using stdio:\n    compile-modules --stdio [--type TYPE] [--imports PATH:GLOBAL] [--module-name MOD]').options({
      type: {
        "default": 'amd',
        describe: 'The type of output (one of "amd", "yui", "cjs", or "globals")'
      },
      to: {
        describe: 'A directory in which to write the resulting files'
      },
      imports: {
        describe: 'A list of path:global pairs, comma separated (e.g. jquery:$,ember:Ember)'
      },
      graph: {
        "default": false,
        type: 'boolean',
        describe: 'Generate a json file containing the dependency graph'
      },
      'infer-name': {
        "default": false,
        type: 'boolean',
        describe: 'Automatically generate names for AMD and YUI modules'
      },
      'module-name': {
        describe: 'The name of the outputted module',
        alias: 'm'
      },
      stdio: {
        "default": false,
        type: 'boolean',
        alias: 's',
        describe: 'Use stdin and stdout to process a file'
      },
      global: {
        describe: 'When the type is `globals`, the name of the global to export into'
      },
      help: {
        "default": false,
        type: 'boolean',
        alias: 'h',
        describe: 'Shows this help message'
      }
    }).check(({type}) => type === 'amd' || type === 'yui' || type === 'cjs' || type === 'globals')
    .check(args => !args['infer-name'] || !args.m)
    .check(args => (args.stdio && args.type === 'amd') ? !args['infer-name'] : true)
    .check(args => (args.stdio && args.type === 'yui') ? !args['infer-name'] : true)
    .check(args => args.stdio || args.to || args.help)
    .check(args => args.imports ? args.type === 'globals' : args.type !== 'globals');
  }

  processStdio(options) {
    this.processIO(this.stdin, this.stdout, options);
  }

  processIO(input, output, options, callback) {
    var data = '',
        self = this;

    function write(chunk) {
      data += chunk;
    }

    function end() {
      /* jshint -W040 */
      this.queue(self._compile(data, options.m, options.type, options));
      this.queue(null);

      if (callback) {
        callback();
      }
    }

    input.pipe(through(write, end)).pipe(output);
  }

  processPath(filename, options, callback) {
    this.fs.stat(filename, function(err, stat) {
      if (err) {
        throw new Error(err);
      } else if (stat.isDirectory()) {
        this.processDirectory(filename, options, callback);
      } else {
        this.processFile(filename, options, callback);
      }
    }.bind(this));
  }

  processDirectory(dirname, options, callback) {
    this.fs.readdir(dirname, function(err, children) {
      if (err) {
        console.error(err.message);
        process.exit(1);
      }
      children.forEach(function(child) {
        this.processPath(path.join(dirname, child), options, callback);
      }.bind(this));
    }.bind(this));
  }

  processFile(filename, options, callback) {
    var ext            = path.extname(filename),
        basenameNoExt  = path.basename(filename, ext),
        dirname        = path.dirname(filename),
        pathNoExt      = normalizePath(path.join(dirname, basenameNoExt)),
        output,
        outputFilename = normalizePath(path.join(options.to, filename)),
        moduleName     = options['infer-name'] ? pathNoExt : null;

    options = extend({}, options, {m: moduleName});
    this._mkdirp(path.dirname(outputFilename));

    this.processIO(
      this.fs.createReadStream(filename),
      this.fs.createWriteStream(outputFilename),
      options,
      callback
    );
  }

  appendNode(compiler, graph) {
    if (graph) {
      graph[compiler.moduleName] = {
        requires: new this.AbstractCompiler(compiler).dependencyNames
      };
    }
  }

  _compile(input, moduleName, type, options) {
    var compiler, method, graph;
    type = {
      amd: 'AMD',
      yui: 'YUI',
      cjs: 'CJS',
      globals: 'Globals'
    }[type];
    compiler = new this.Compiler(input, moduleName, options);
    this.appendNode(compiler, options.graph);
    method = "to" + type;
    return compiler[method]();
  }

  _mkdirp(directory) {
    var prefix;
    if (this.fs.existsSync(directory)) {
      return;
    }
    prefix = path.dirname(directory);
    if (prefix !== '.' && prefix !== '/') {
      this._mkdirp(prefix);
    }
    return this.fs.mkdirSync(directory);
  }
}

CLI.start = function(Compiler, AbstratCompiler, argv, stdin=process.stdin, stdout=process.stdout, fs_=fs) {
  return new CLI(Compiler, AbstractCompiler, stdin, stdout, fs_).start(argv);
};

let fs   = require('fs'),
    path = require('path');

function requireMain() {
  var root    = path.join(__dirname, '..'),
      pkgPath = path.join(root, 'package.json'),
      pkg     = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));

  return require(path.join(root, pkg.main));
}

let main = requireMain();
let Compiler = main.Compiler;
let AbstractCompiler = main.AbstractCompiler;

CLI.start(Compiler, AbstractCompiler, process.argv);
