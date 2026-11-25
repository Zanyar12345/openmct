export default function RosRealtimePlugin(rosUrl) {
        return function (openmct) {
            
            const ros = new ROSLIB.Ros({ url: rosUrl });

            var provider = {
                supportsSubscribe: function (domainObject) {
                    return domainObject.type === 'hotas.telemetry';
                },
                subscribe: function (domainObject, callback) {
                    const topic = domainObject.topicName; 
                    
                    const listener = new ROSLIB.Topic({
                        ros: ros,
                        name: topic,
                        messageType: domainObject.rosType
                    });

                    listener.subscribe((message) => {
                        // Extract the first numeric value found in complex messages (e.g. geometry_msgs/Twist)
                        function extractNumericValue(obj) {
                            if (typeof obj === 'number') return obj;
                            if (typeof obj === 'object' && obj !== null) {
                                for (let key in obj) {
                                    let result = extractNumericValue(obj[key]);
                                    if (result !== undefined) return result;
                                }
                            }
                            return undefined;
                        }

                        let val = extractNumericValue(message);

                        callback({
                            id: domainObject.identifier.key,
                            timestamp: Date.now(),
                            value: val
                        });
                    });

                    return function unsubscribe() {
                        listener.unsubscribe();
                    };
                },
                supportsRequest: function (domainObject) {
                    return domainObject.type === 'hotas.telemetry';
                },
                request: function (domainObject, options) {
                    const topicKey = domainObject.identifier.key;
                    const url = `http://localhost:8081/history/${topicKey}?start=${options.start}&end=${options.end}`;

                    return fetch(url)
                        .then(response => response.json())
                        .then(data => {
                            return data.map(point => ({
                                id: domainObject.identifier.key,
                                timestamp: point.timestamp, 
                                value: point.value
                            }));
                        });
                }
            };

            openmct.telemetry.addProvider(provider);
    };
}
