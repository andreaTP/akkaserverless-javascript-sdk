/*
 * Copyright 2021 Lightbend Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

const debug = require("debug")("akkaserverless-replicated-entity");
const util = require("util");
const AnySupport = require("../protobuf-any");

function mapIterator(iter, f) {
  const mapped = {
    [Symbol.iterator]: () => mapped,
    next: () => {
      const next = iter.next();
      if (next.done) {
        return {
          done: true
        };
      } else {
        return {
          value: f(next.value),
          done: false
        };
      }
    }
  };
  return mapped;
}

/**
 * @classdesc An Observed-Removed Map Replicated Data type.
 *
 * Observed-Removed-Map's are a mapping of keys (which can be any {@link module:akkaserverless.Serializable}) to
 * Replicated Data types. Values of the map are merged together. Elements can be added and removed, however, when an
 * element is removed and then added again, it's possible that the old value will be merged with the new, depending on
 * whether the remove was replicated to all nodes before the add was.
 *
 * Note that while the map may contain different types of Replicated Data for different keys, a given key may not change
 * its type, and doing so will likely result in the Replicated Data entering a non mergable state, from which it can't
 * recover.
 *
 * @constructor module:akkaserverless.replicatedentity.ORMap
 * @implements module:akkaserverless.replicatedentity.ReplicatedData
 */
function ORMap() {
  // Map of a comparable form (that compares correctly using ===) to an object that holds the
  // actual key and the value.
  let currentValue = new Map();
  let delta = {
    added: new Map(),
    removed: new Map(),
    cleared: false
  };

  /**
   * Generator for default values.
   *
   * This is invoked by get when the current map has no Replicated Data defined for the key.
   *
   * If this returns a Replicated Data object, it will be added to the map.
   *
   * Care should be taken when using this, since it means that the get method can trigger elements to be created. If
   * using default values, the get method should not be used in queries where an empty value for the Replicated Data
   * means the value is not present.
   *
   * @callback module:akkaserverless.replicatedentity.ORMap~defaultValueCallback
   * @param {module:akkaserverless.Serializable} key The key the default value is being generated for.
   * @returns {undefined|akkaserverless.replicatedentity.ReplicatedData} The default value, or undefined if no default value should be returned.
   */

  /**
   * Generator for default values.
   *
   * This is invoked by get when the current map has no Replicated Data defined for the key.
   *
   * If this returns a Replicated Data object, it will be added to the map.
   *
   * Care should be taken when using this, since it means that the get method can trigger elements to be created. If
   * using default values, the get method should not be used in queries where an empty value for the Replicated Data
   * means the value is not present.
   *
   * @name module:akkaserverless.replicatedentity.ORMap#defaultValue
   * @type {module:akkaserverless.replicatedentity.ORMap~defaultValueCallback}
   */
  this.defaultValue = (key) => undefined;

  /**
   * Check whether this map contains a value of the given key.
   *
   * @function module:akkaserverless.replicatedentity.ORMap#has
   * @param {module:akkaserverless.Serializable} key The key to check.
   * @returns {boolean} True if this map contains a value of the given key.
   */
  this.has = function(key) {
    return currentValue.has(AnySupport.toComparable(key));
  };

  /**
   * The number of elements in this map.
   *
   * @name module:akkaserverless.replicatedentity.ORMap#size
   * @type {number}
   * @readonly
   */
  Object.defineProperty(this, "size", {
    get: function () {
      return currentValue.size;
    }
  });

  /**
   * Callback for handling elements iterated through by {@link module:akkaserverless.replicatedentity.ORMap#forEach}.
   *
   * @callback module:akkaserverless.replicatedentity.ORMap~forEachCallback
   * @param {module:akkaserverless.replicatedentity.ReplicatedData} value The Replicated Data value.
   * @param {module:akkaserverless.Serializable} key The key.
   * @param {module:akkaserverless.ORMap} This map.
   */

  /**
   * Execute the given callback for each element.
   *
   * @function module:akkaserverless.replicatedentity.ORMap#forEach
   * @param {module:akkaserverless.replicatedentity.ORMap~forEachCallback} callback The callback to handle each element.
   */
  this.forEach = function(callback) {
    return currentValue.forEach((value, key) => callback(value.value, value.key, this));
  };

  /**
   * Return an iterator of the entries of this map.
   *
   * @function module:akkaserverless.replicatedentity.ORMap#entries
   * @returns {Iterator<Array>}
   */
  this.entries = function() {
    // For some reason, these arrays are key, value, even though callbacks are passed value, key
    return mapIterator(currentValue.values(), value => [value.key, value.value]);
  };

  /**
   * Return an iterator of the entries of this map.
   *
   * @function module:akkaserverless.replicatedentity.ORMap#@@iterator
   * @returns {iterator<Array>}
   */
  this[Symbol.iterator] = function() {
    return entries();
  };

  /**
   * Return an iterator of the values of this map.
   *
   * @function module:akkaserverless.replicatedentity.ORMap#values
   * @returns {iterator<module:akkaserverless.replicatedentity.ReplicatedData>}
   */
  this.values = function() {
    return mapIterator(currentValue.values(), value => value.value);
  };

  /**
   * Return an iterator of the keys of this map.
   *
   * @function module:akkaserverless.replicatedentity.ORMap#keys
   * @returns {iterator<module:akkaserverless.Serializable>}
   */
  this.keys = function() {
    return mapIterator(currentValue.values(), value => value.key);
  };

  /**
   * Get the value at the given key.
   *
   * @function {module:akkaserverless.replicatedentity.ORMap#get}
   * @param {module:akkaserverless.Serializable} key The key to get.
   * @returns {undefined|module:akkaserverless.replicatedentity.ReplicatedData} The Replicated Data value, or undefined if no value is defined at that key.
   */
  this.get = (key) => {
    const value = currentValue.get(AnySupport.toComparable(key));
    if (value !== undefined) {
      return value.value;
    } else {
      const maybeDefault = this.defaultValue(key);
      if (maybeDefault !== undefined) {
        this.set(key, maybeDefault)
      }
      return maybeDefault;
    }
  };

  const asObject = new Proxy({}, {
    get: (target, key) => this.get(key),
    set: (target, key, value) => this.set(key, value),
    deleteProperty: (target, key) => this.delete(key),
    ownKeys: (target) => {
      const keys = [];
      this.forEach((value, key) => {
        if (typeof key === "string") {
          keys.push(key);
        }
      });
      return keys;
    },
    has: (target, key) => this.has(key),
    defineProperty: () => {
      throw new Error("ORMap.asObject does not support defining properties");
    },
    getOwnPropertyDescriptor: (target, key) => {
      const value = this.get(key);
      return value ? {
        value: value,
        writable: true,
        enumerable: true,
        configurable: true
      } : undefined;
    }
  });

  /**
   * A representation of this map as an object.
   *
   * All entries whose keys are strings will be properties of this object, and setting any property of the object will
   * insert that property as a key into the map.
   *
   * @name module:akkaserverless.replicatedentity.ORMap#asObject
   * @type {Object<String, module:akkaserverless.replicatedentity.ReplicatedData>}
   */
  Object.defineProperty(this, "asObject", {
    get: () => asObject
  });

  /**
   * Set the given value for the given key.
   *
   * @function module:akkaserverless.replicatedentity.ORMap#set
   * @param {module:akkaserverless.Serializable} key The key to set.
   * @param {module:akkaserverless.replicatedentity.ReplicatedData} value The value to set.
   * @return {module:akkaserverless.replicatedentity.ORMap} This map.
   */
  this.set = function(key, value) {
    if (!value.hasOwnProperty("getAndResetDelta")) {
      throw new Error(util.format("Cannot add %o with value %o to ORMap, only Replicated Data types may be added as values.", key, value))
    }
    const comparable = AnySupport.toComparable(key);
    const serializedKey = AnySupport.serialize(key, true, true);
    if (!currentValue.has(comparable)) {
      if (delta.removed.has(comparable)) {
        debug("Removing then adding key [%o] in the same operation can have unintended effects, as the old value may end up being merged with the new.", key);
      }
    } else if (!delta.added.has(comparable)) {
      debug("Setting an existing key [%o] to a new value can have unintended effects, as the old value may end up being merged with the new.", key);
      delta.removed.set(comparable, serializedKey);
    }
    // We'll get the actual state later
    delta.added.set(comparable, serializedKey);
    currentValue.set(comparable, {
      key: key,
      value: value
    });
    return this;
  };

  /**
   * Delete the value at the given key.
   *
   * @function module:akkaserverless.replicatedentity.ORMap#delete
   * @param {module:akkaserverless.Serializable} key The key to delete.
   * @return {module:akkaserverless.replicatedentity.ORMap} This map.
   */
  this.delete = function(key) {
    const comparable = AnySupport.toComparable(key);
    if (currentValue.has(comparable)) {
      if (currentValue.size === 1) {
        this.clear();
      } else {
        currentValue.delete(comparable);
        if (delta.added.has(comparable)) {
          delta.added.delete(comparable);
        } else {
          const serializedKey = AnySupport.serialize(key, true, true);
          delta.removed.set(comparable, serializedKey);
        }
      }
    }
    return this;
  };

  /**
   * Clear all entries from this map.
   *
   * @function module:akkaserverless.replicatedentity.ORMap#clear
   * @return {module:akkaserverless.replicatedentity.ORMap} This map.
   */
  this.clear = function() {
    if (currentValue.size > 0) {
      delta.cleared = true;
      delta.added.clear();
      delta.removed.clear();
      currentValue.clear();
    }
    return this;
  };

  this.getAndResetDelta = function(initial) {
    const updateDeltas = [];
    const addedDeltas = [];
    currentValue.forEach((value, key) => {
      if (delta.added.has(key)) {
        addedDeltas.push({
          key: delta.added.get(key),
          delta: value.value.getAndResetDelta(/* initial = */ true)
        });
      } else {
        const entryDelta = value.value.getAndResetDelta();
        if (entryDelta !== null) {
          updateDeltas.push({
            key: AnySupport.serialize(value.key, true, true),
            delta: entryDelta
          });
        }
      }
    });

    if (delta.cleared || delta.removed.size > 0 || updateDeltas.length > 0 || addedDeltas.length > 0 || initial) {
      const currentDelta = {
        ormap: {
          cleared: delta.cleared,
          removed: Array.from(delta.removed.values()),
          added: addedDeltas,
          updated: updateDeltas
        }
      };
      delta.cleared = false;
      delta.added.clear();
      delta.removed.clear();
      return currentDelta;
    } else {
      return null;
    }
  };

  this.applyDelta = function(delta, anySupport, createForDelta) {
    if (!delta.ormap) {
      throw new Error(util.format("Cannot apply delta %o to ORMap", delta));
    }
    if (delta.ormap.cleared) {
      currentValue.clear();
    }
    if (delta.ormap.removed !== undefined) {
      delta.ormap.removed.forEach(key => {
        const deserializedKey = anySupport.deserialize(key);
        const comparable = AnySupport.toComparable(deserializedKey);
        if (currentValue.has(comparable)) {
          currentValue.delete(comparable);
        } else {
          debug("Delta instructed to delete key [%o], but it wasn't in the ORMap.", deserializedKey)
        }
      });
    }
    if (delta.ormap.added !== undefined) {
      delta.ormap.added.forEach(entry => {
        const value = createForDelta(entry.delta);
        value.applyDelta(entry.delta, anySupport, createForDelta);
        const key = anySupport.deserialize(entry.key);
        const comparable = AnySupport.toComparable(key);
        if (currentValue.has(comparable)) {
          debug("Delta instructed to add key [%o], but it's already present in the ORMap. Updating with delta instead.", key);
          currentValue.get(comparable).value.applyDelta(entry.delta, anySupport, createForDelta);
        } else {
          currentValue.set(comparable, {
            key: key,
            value: value
          });
        }
      });
    }
    if (delta.ormap.updated !== undefined) {
      delta.ormap.updated.forEach(entry => {
        const key = anySupport.deserialize(entry.key);
        const comparable = AnySupport.toComparable(key);
        if (currentValue.has(comparable)) {
          currentValue.get(comparable).value.applyDelta(entry.delta, anySupport, createForDelta);
        } else {
          debug("Delta instructed to update key [%o], but it's not present in the ORMap.", key);
        }
      });
    }
  };

  this.toString = function() {
    return "ORMap(" + Array.from(currentValue.values())
      .map(entry => entry.key + " -> " + entry.value.toString())
      .join(",") + ")";
  };
}

module.exports = ORMap;
