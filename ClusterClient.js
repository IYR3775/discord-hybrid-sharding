const Discord = require('discord.js');
const { Events } = Discord.Constants
const Util = Discord.Util;
///communicates between the master workers and the process
class ClusterClient{
   /**
   * @param {Client} client Client of the current cluster
   */
   constructor(client, mode) {
    /**
     * Client for the Cluser
     * @type {Client}
     */
    this.client = client;

    /**
     * Mode the Cluster was spawned with
     * @type {ClusterManagerMode}
     */
    this.mode = this.info.CLUSTER_MANAGER_MODE;
    mode = this.mode;
    /**
     * Message port for the master process (only when {@link ClusterClientUtil#mode} is `worker`)
     * @type {?MessagePort}
     */
     this.parentPort = null;
     
     if (mode === 'process') {
        process.on('message', this._handleMessage.bind(this));
        client.on('ready', () => {
          process.send({ _ready: true });
        });
        client.on('disconnect', () => {
          process.send({ _disconnect: true });
        });
        client.on('reconnecting', () => {
          process.send({ _reconnecting: true });
        });
      } else if (mode === 'worker') {
        this.parentPort = require('worker_threads').parentPort;
        this.parentPort.on('message', this._handleMessage.bind(this));
        client.on('ready', () => {
          this.parentPort.postMessage({ _ready: true });
        });
        client.on('disconnect', () => {
          this.parentPort.postMessage({ _disconnect: true });
        });
        client.on('reconnecting', () => {
          this.parentPort.postMessage({ _reconnecting: true });
        });
      }
    
   }
    /**
   * cluster's id
   * @type {number[]}
   * @readonly
   */
    get id() {
      return this.info.CLUSTER;
    }
   /**
   * Array of shard IDs of this client
   * @type {number[]}
   * @readonly
   */
   get ids() {
    return this.client.ws.shards;
   }
   /**
   * Total number of clusters
   * @type {number}
   * @readonly
   */
   get count() {
     return this.info.CLUSTER_COUNT;
   }
   /**
   * Gets several Info like Cluster_Count, Number, Totalshards...
   * @type {Object}
   * @readonly
   */
   get info(){
    let clustermode = process.env.CLUSTER_MANAGER_MODE;
    if(!clustermode) return
    if(clustermode !== "worker" && clustermode !== "process") throw new Error("NO CHILD/MASTER EXISTS OR SUPPLIED CLUSTER_MANAGER_MODE IS INCORRECT");
    let data;
    if(clustermode === "process"){ 
      const shardlist = [];
      let parseshardlist =  process.env.SHARD_LIST.split(",")
      parseshardlist.forEach(c =>shardlist.push(Number(c)))
      data = {SHARD_LIST: shardlist, TOTAL_SHARDS: Number(process.env.TOTAL_SHARDS), CLUSTER_COUNT: Number(process.env.CLUSTER_COUNT), CLUSTER: Number(process.env.CLUSTER), CLUSTER_MANAGER_MODE: clustermode}
    }else{
      data = require("worker_threads").workerData 
    }
    return data;
   }
   /**
   * Sends a message to the master process.
   * @param {*} message Message to send
   * @returns {Promise<void>}
   * @emits Cluster#message
   */
  send(message) {
    //console.log(message)
    return new Promise((resolve, reject) => {
      if (this.mode === 'process') {
        process.send(message, err => {
          if (err) reject(err);
          else resolve();
        });
      } else if (this.mode === 'worker') {
        this.parentPort.postMessage(message);
        resolve();
      }
    });
  }
    /**
   * Fetches a client property value of each shard, or a given shard.
   * @param {string} prop Name of the client property to get, using periods for nesting
   * @param {number} [shard] Shard to fetch property from, all if undefined
   * @returns {Promise<*>|Promise<Array<*>>}
   * @example
   * client.shard.fetchClientValues('guilds.cache.size')
   *   .then(results => console.log(`${results.reduce((prev, val) => prev + val, 0)} total guilds`))
   *   .catch(console.error);
   * @see {@link ClusterManager#fetchClientValues}
   */
  fetchClientValues(prop, shard) {
    return new Promise((resolve, reject) => {
      const parent = this.parentPort || process;

      const listener = message => {
        if (!message || message._sFetchProp !== prop || message._sFetchPropShard !== shard) return;
        parent.removeListener('message', listener);
        if (!message._error) resolve(message._result);
        else reject(Util.makeError(message._error));
      };
      parent.on('message', listener);

      this.send({ _sFetchProp: prop, _sFetchPropShard: shard }).catch(err => {
        parent.removeListener('message', listener);
        reject(err);
      });
    });
  }

  /**
   * Evaluates a script or function on all clustes, or a given cluster, in the context of the {@link Client}s.
   * @param {string|Function} script JavaScript to run on each cluster
   * @param {number} [cluster] Cluster to run script on, all if undefined
   * @returns {Promise<*>|Promise<Array<*>>} Results of the script execution
   * @example
   * client.cluster.broadcastEval('this.guilds.cache.size')
   *   .then(results => console.log(`${results.reduce((prev, val) => prev + val, 0)} total guilds`))
   *   .catch(console.error);
   * @see {@link ClusterManager#broadcastEval}
   */
  broadcastEval(script, cluster) {
    return new Promise((resolve, reject) => {
      const parent = this.parentPort || process;
      script = typeof script === 'function' ? `(${script})(this)` : script;

      const listener = message => {
        if (!message || message._sEval !== script || message._sEvalShard !== cluster) return;
        parent.removeListener('message', listener);
        if (!message._error) resolve(message._result);
        else reject(Util.makeError(message._error));
      };
      parent.on('message', listener);

      this.send({ _sEval: script, _sEvalShard: cluster }).catch(err => {
        parent.removeListener('message', listener);
        reject(err);
      });
    });
  }

  /**
   * Requests a respawn of all clusters.
   * @param {number} [clusterDelay=5000] How long to wait between clusters (in milliseconds)
   * @param {number} [respawnDelay=500] How long to wait between killing a cluster's process/worker and restarting it
   * (in milliseconds)
   * @param {number} [spawnTimeout=30000] The amount in milliseconds to wait for a cluster to become ready before
   * continuing to another. (-1 or Infinity for no wait)
   * @returns {Promise<void>} Resolves upon the message being sent
   * @see {@link ClusterManager#respawnAll}
   */
  respawnAll(clusterDelay = 5000, respawnDelay = 500, spawnTimeout = 30000) {
    return this.send({ _sRespawnAll: { clusterDelay, respawnDelay, spawnTimeout } });
  }

  /**
   * Handles an IPC message.
   * @param {*} message Message received
   * @private
   */
  async _handleMessage(message) {
    if (!message) return;
    if (message._fetchProp) {
      const props = message._fetchProp.split('.');
      let value = this.client;
      for (const prop of props) value = value[prop];
      this._respond('fetchProp', { _fetchProp: message._fetchProp, _result: value });
    } else if (message._eval) {
      try {
        this._respond('eval', { _eval: message._eval, _result: await this.client._eval(message._eval) });
      } catch (err) {
        this._respond('eval', { _eval: message._eval, _error: Util.makePlainError(err) });
      }
    }
  }

  /**
   * Sends a message to the master process, emitting an error from the client upon failure.
   * @param {string} type Type of response to send
   * @param {*} message Message to send
   * @private
   */
  _respond(type, message) {
    this.send(message).catch(err => {
      let error = {err};
  
      error.message = `Error when sending ${type} response to master process: ${err.message}`;
      /**
       * Emitted when the client encounters an error.
       * @event Client#error
       * @param {Error} error The error encountered
       */
      this.client.emit(Events.ERROR, error);
    });
  }

  /**
   * Creates/gets the singleton of this class.
   * @param {Client} client The client to use
   * @param {ClusterManagerMode} mode Mode the cluster was spawned with
   * @returns {ShardClientUtil}
   */
  static singleton(client, mode) {
    if (!this._singleton) {
      this._singleton = new this(client, mode);
    } else {
      client.emit(
        Events.WARN,
        'Multiple clients created in child process/worker; only the first will handle clustering helpers.',
      );
    }
    return this._singleton;
  }
  /**
   * gets the total Internalshardcount and shard list.
   * @returns {ClusterClientUtil}
   */
  static getinfo(){
    let clustermode = process.env.CLUSTER_MANAGER_MODE;
    if(!clustermode) return
    if(clustermode !== "worker" && clustermode !== "process") throw new Error("NO CHILD/MASTER EXISTS OR SUPPLIED CLUSTER_MANAGER_MODE IS INCORRECT");
    let data;
    if(clustermode === "process"){ 
      const shardlist = [];
      let parseshardlist =  process.env.SHARD_LIST.split(",")
      parseshardlist.forEach(c =>shardlist.push(Number(c)))
      data = {SHARD_LIST: shardlist, TOTAL_SHARDS: Number(process.env.TOTAL_SHARDS), CLUSTER_COUNT: Number(process.env.CLUSTER_COUNT), CLUSTER: Number(process.env.CLUSTER), CLUSTER_MANAGER_MODE: clustermode}
    }else{
      data = require("worker_threads").workerData 
    }
    return data;
  }
 

}
module.exports = ClusterClient;