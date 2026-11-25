export default function RosDictionaryPlugin(rosUrl) {
        return function install(openmct) {
            // 1. Setup ROS Connection
            // We assume ROSLIB is loaded globally via the script tag in index.html
            const ros = new ROSLIB.Ros({ url: rosUrl });

            function getRosTopics() {
                // Fetch from History Server instead of ROS.
                // This is crucial for Playback mode when ROS is offline!
                return fetch('http://localhost:8081/topics')
                    .then(response => response.json())
                    .then(data => {
                        return data; 
                    })
                    .catch(error => {
                        console.error("Failed to fetch topics from History Server:", error);
                        return { topics: [], types: [] };
                    });
            }

            function getTelemetryMetadata(rosType) {
                let values = [
                    {
                        key: "value",
                        name: "Value",
                        hints: { range: 1 }
                    },
                    {
                        key: "utc",
                        source: "timestamp",
                        name: "Timestamp",
                        format: "utc",
                        hints: { domain: 1 }
                    }
                ];

                if (rosType.includes('Int') || rosType.includes('Float') || rosType.includes('Double')) {
                    values[0].format = 'float';
                } else if (rosType.includes('Bool')) {
                    values[0].format = 'enum';
                    values[0].enumerations = [
                        { value: 0, string: "FALSE" },
                        { value: 1, string: "TRUE" }
                    ];
                } else if (rosType.includes('String')) {
                    values[0].format = 'string';
                }

                return { values: values };
            }

            const rosObjectProvider = {
                get: function (identifier) {
                    if (identifier.key === 'ros-root') {
                        return Promise.resolve({
                            identifier: identifier,
                            name: 'ROS 2 Topics',
                            type: 'folder',
                            location: 'ROOT'
                        });
                    }

                    return getRosTopics().then(data => {
                        const topicName = '/' + identifier.key.replace(/:/g, '/');
                        const index = data.topics.indexOf(topicName);
                        
                        if (index !== -1) {
                            const rosType = data.types[index];
                            return {
                                identifier: identifier,
                                name: topicName,
                                type: 'hotas.telemetry',
                                telemetry: getTelemetryMetadata(rosType),
                                topicName: topicName,
                                rosType: rosType,
                                location: 'ros.taxonomy:ros-root'
                            };
                        } else {
                            return undefined;
                        }
                    });
                }
            };

            const rosCompositionProvider = {
                appliesTo: function (domainObject) {
                    return domainObject.identifier.key === 'ros-root';
                },
                load: function (domainObject) {
                    return getRosTopics().then(data => {
                        return data.topics.map(topic => {
                            const safeKey = topic.substring(1).replace(/\//g, ':');
                            return {
                                namespace: 'ros.taxonomy',
                                key: safeKey
                            };
                        });
                    });
                }
            };

            openmct.objects.addRoot({
                namespace: 'ros.taxonomy',
                key: 'ros-root'
            });
            openmct.objects.addProvider('ros.taxonomy', rosObjectProvider);
            openmct.composition.addProvider(rosCompositionProvider);
            
            if (openmct.types.get('hotas.telemetry') === undefined) {
                openmct.types.addType('hotas.telemetry', {
                    name: 'ROS Telemetry Point',
                    cssClass: 'icon-telemetry'
                });
            }
    };
}
