'use strict';

var path         = require('path')
  , chai         = require('chai')
  , expect       = chai.expect
  , helper       = require(path.join(__dirname, 'lib', 'agent_helper'))
  , logger       = require(path.join(__dirname, '..', 'lib', 'logger'))
  , shimmer      = require(path.join(__dirname, '..', 'lib', 'shimmer'))
  , EventEmitter = require('events').EventEmitter
  ;

describe("the instrumentation injector", function () {
  var nodule = {
    c : 2,
    ham : 'ham',
    doubler : function (x, cb) {
      cb(this.c + x * 2);
    },
    tripler : function (y, cb) {
      cb(this.c + y * 3);
    },
    hammer : function (h, cb) {
      cb(this.ham + h);
    }
  };

  it("should wrap a method", function () {
    var doubled = 0;
    var before = false;
    var after = false;

    shimmer.wrapMethod(nodule, 'nodule', 'doubler', function (original) {
      return function () {
        before = true;
        original.apply(this, arguments);
        after = true;
      };
    });

    expect(nodule.doubler.__NR_unwrap).a('function');

    nodule.doubler(7, function(z) { doubled = z; });

    expect(doubled).equal(16);
    expect(before).equal(true);
    expect(after).equal(true);
  });

  it("should wrap, then unwrap a method", function () {
    var tripled = 0;
    var before = false;
    var after = false;

    shimmer.wrapMethod(nodule, 'nodule', 'tripler', function (original) {
      return function () {
        before = true;
        original.apply(this, arguments);
        after = true;
      };
    });

    nodule.tripler(7, function(z) { tripled = z; });

    expect(tripled).equal(23);
    expect(before).equal(true);
    expect(after).equal(true);

    before = false;
    after = false;

    shimmer.unwrapMethod(nodule, 'nodule', 'tripler');

    nodule.tripler(9, function(j) { tripled = j; });

    expect(tripled).equal(29);
    expect(before).equal(false);
    expect(after).equal(false);
  });

  it("shouldn't break anything when an NR-wrapped method is wrapped again", function () {
    var hamceptacle = '';
    var before = false;
    var after = false;
    var hammed = false;

    shimmer.wrapMethod(nodule, 'nodule', 'hammer', function (original) {
      return function () {
        before = true;
        original.apply(this, arguments);
        after = true;
      };
    });

    // monkey-patching the old-fashioned way
    var hammer = nodule.hammer;
    nodule.hammer = function () {
      hammer.apply(this, arguments);
      hammed = true;
    };

    nodule.hammer('Burt', function (k) { hamceptacle = k; });

    expect(hamceptacle).equal('hamBurt');
    expect(before).equal(true);
    expect(after).equal(true);
    expect(hammed).equal(true);
  });

  describe("with full instrumentation running", function () {
    var agent;

    beforeEach(function () {
      agent = helper.loadMockedAgent();
    });

    afterEach(function () {
      helper.unloadAgent(agent);
    });

    it("should push transactions through process.nextTick", function (done) {
      expect(agent.getTransaction()).equal(undefined);

      var synchronizer = new EventEmitter()
        , transactions = []
        , ids          = []
        ;

      var spamTransaction = function (i) {
        // need to ensure that each one gets created in its own context
        (function (i) {
          var current = agent.createTransaction();
          transactions[i] = current;
          ids[i] = current.id;

          process.nextTick(function () {
            var lookup = agent.getTransaction();
            expect(lookup).equal(current);

            synchronizer.emit('inner', lookup, i);
          });
        }(i));
      };

      var doneCount = 0;
      synchronizer.on('inner', function (trans, j) {
        doneCount += 1;
        expect(trans).equal(transactions[j]);
        expect(trans.id).equal(ids[j]);

        trans.end();

        if (doneCount === 10) return done();
      });

      for (var i = 0; i < 10; i += 1) {
        process.nextTick(spamTransaction.bind(this, i));
      }
    });

    it("should push transactions through setTimeout", function (done) {
      expect(agent.getTransaction()).equal(undefined);

      var synchronizer = new EventEmitter()
        , transactions = []
        , ids          = []
        ;

      var spamTransaction = function (i) {
        // need to ensure that each one gets created in its own context
        (function (i) {
          var current = agent.createTransaction();
          transactions[i] = current;
          ids[i] = current.id;

          setTimeout(function () {
            var lookup = agent.getTransaction();
            expect(lookup).equal(current);

            synchronizer.emit('inner', lookup, i);
          }, 1);
        }(i));
      };

      var doneCount = 0;
      synchronizer.on('inner', function (trans, j) {
        doneCount += 1;
        expect(trans).equal(transactions[j]);
        expect(trans.id).equal(ids[j]);

        trans.end();

        if (doneCount === 10) return done();
      });

      for (var i = 0; i < 10; i += 1) {
        // You know what this test needs? Some non-determinism!
        var timeout = Math.floor(Math.random() * 20);
        setTimeout(spamTransaction.bind(this, i), timeout);
      }
    });

    it("should push transactions through EventEmitters", function (done) {
      expect(agent.getTransaction()).equal(undefined);

      var eventer      = new EventEmitter()
        , transactions = []
        , ids          = []
        ;

      var eventTransaction = function (j) {
        var current = agent.createTransaction()
          , id      = current.id
          , name    = ('ttest' + (j + 1))
          ;

        transactions[j] = current;
        ids[j]          = id;

        eventer.on(name, function () {
          var lookup = agent.getTransaction();
          expect(lookup).equal(current);
          expect(lookup.id).equal(id);

          eventer.emit('inner', lookup, j);
        });

        eventer.emit(name);
      };

      var doneCount = 0;
      eventer.on('inner', function (trans, j) {
        doneCount += 1;
        expect(trans).equal(transactions[j]);
        expect(trans.id).equal(ids[j]);

        trans.end();

        if (doneCount === 10) return done();
      });

      for (var i = 0; i < 10; i += 1) {
        eventTransaction(i);
      }
    });

    it("should handle whatever ridiculous nonsense you throw at it", function (done) {
      expect(agent.getTransaction()).equal(undefined);

      var synchronizer = new EventEmitter()
        , eventer      = new EventEmitter()
        , transactions = []
        , ids = []
        , doneCount = 0
        ;

      var verify = function (i, phase, passed) {
        var lookup = agent.getTransaction();
        logger.verbose(i + ' ' + phase + ' ' +
                       (lookup ? lookup.id : 'missing') + ' ' +
                       (passed ? passed.id : 'missing'));
        expect(lookup).equal(passed);
        expect(lookup).equal(transactions[i]);
        expect(lookup.id).equal(ids[i]);
      };

      eventer.on('rntest', function(trans, j) {
        verify(j, 'eventer', trans);
        synchronizer.emit('inner', trans, j);
      });

      var createTimer = function (trans, j) {
        return function () {
          verify(j, 'createTimer', trans);
          eventer.emit('rntest', trans, j);
        };
      };

      var createTicker = function (j) {
        return function () {
          var current = agent.createTransaction();
          transactions[j] = current;
          ids[j] = current.id;

          verify(j, 'createTicker', current);

          process.nextTick(function () {
            verify(j, 'nextTick', current);
            setTimeout(createTimer(current, j), 0);
          });
        };
      };

      synchronizer.on('inner', function (trans, j) {
        verify(j, 'synchronizer', trans);
        doneCount += 1;
        expect(trans).equal(transactions[j]);
        expect(trans.id).equal(ids[j]);

        trans.end();

        if (doneCount === 10) return done();
      });

      for (var i = 0; i < 10; i++) {
        process.nextTick(createTicker(i));
      }
    });
  });
});